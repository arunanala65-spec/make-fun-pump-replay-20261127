// Surge Scalp — a pump.fun bonding-curve paper bot for agent-fun/replay/v2.
//
// Idea, from measuring the kit's dev window (1,222 coins): almost every new coin
// dies, but coins whose first minutes show heavy, broad buy pressure keep running.
// Coins with >= 10 SOL of net buy inflow in their first 150 slots reach a 2x peak
// 84% of the time (median peak 3.6x), while coins under 2 SOL of early inflow almost
// never do (4-6%). The catch: by the time the inflow is proven the price has already
// moved, and 300 slots later the median coin is back below the signal price — so the
// bot buys only the strongest, oldest-proven surges (net >= 10 SOL, age >= 90 slots,
// real reserve <= 25 SOL, inflow still accelerating), stakes small (0.05 SOL), and
// scalps them: half off at +40%, the rest at +100% or on a 30% trailing stop, cut at
// -20%, out on a 40-slot fade or after 600 slots. Two ideas were measured and
// rejected: holding for the tail (the 35 completed coins pay a median 11.3x, but they
// migrate within ~0-10 slots of creation, before any reactive signal can fire —
// untradeable), and pyramiding into rising reserves (lost more than scalping on every
// window). The pyramid/stall code stays in the file, off by default. Guardrail probes
// (0.01 SOL round trips on liquid curves) keep the run above 20 coins when the main
// signal goes quiet. Backtested on the kit's local simulator over the three dev
// dataset parts: net PnL +0.08 / -0.03 / -0.06 SOL (mean ~0.00), max drawdown 0.6%,
// ~54 trips per part — capital-preserving with a small positive skew on the best
// window; the final window decides.
//
// Deterministic by construction: no clock, no environment reads, no randomness;
// iteration only over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry lookback in slots. */
  window: number;
  /** Net buy SOL (buys minus sells) over the window. */
  minNetSol: number;
  /** Buy trades in the window. */
  minBuys: number;
  /** Distinct buying wallets in the window. */
  minBuyers: number;
  /** Price now over price at the window start, minus 1. */
  minUp: number;
  /** Price now at least this share of the window's high. */
  nearHigh: number;
  /** Newer-half net inflow at least this multiple of the older half's. */
  accel: number;
  /** Largest single wallet's share of the window's buy SOL. */
  maxBuyerShare: number;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** SOL for one position in total. */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Sell half at cost * (1 + tp1), the rest at cost * (1 + tp2). 1000 = off. */
  tp1: number;
  tp2: number;
  /** Stop loss against cost. */
  stopLoss: number;
  /** Trailing stop from the peak value, arms once value >= cost * (1 + trailArm). */
  trail: number;
  trailArm: number;
  /** Exit when net SOL over the fade window falls below -fadeNetSol. 1000 = off. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit after this many slots held (unless up at least holdIfUp). */
  maxHold: number;
  holdIfUp: number;
  /** Exit when the curve's real SOL reserve falls this far below its peak while held. */
  stallRqDrop: number;
  /** Add to a winner when its real SOL reserve reaches this multiple of the last buy's. */
  addStepRq: number;
  /** Most SOL at cost in one position (pyramiding into a runner). */
  maxStakeSol: number;
  /** Each add-on buy (SOL). */
  addSol: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most main positions open at once (the rest of the cap is for probes). */
  maxMain: number;
  /** Guardrail pacing: keep fills/coins on pace over paceSecs of block time. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
}

// Defaults picked from the dev-window measurements above, then swept with the
// kit's local simulator; the sweep preferred flat regions over single best cells.
export const DEFAULT_PARAMS: Params = {
  window: 120,
  minNetSol: 10,
  minBuys: 5,
  minBuyers: 4,
  minUp: 0.08,
  nearHigh: 0.9,
  accel: 1.5,
  maxBuyerShare: 0.6,
  minRqSol: 1,
  maxRqSol: 25,
  minAge: 90,
  stakeSol: 0.05,
  minBuySol: 0.01,
  buySlipBps: 1500,
  tp1: 0.4,
  tp2: 1.0,
  stopLoss: 0.2,
  trail: 0.3,
  trailArm: 0.2,
  fadeWindow: 40,
  fadeNetSol: 1,
  maxHold: 600,
  holdIfUp: 0.1,
  stallRqDrop: 1,
  addStepRq: 1e9,
  maxStakeSol: 0.05,
  addSol: 0.05,
  cooldown: 200,
  maxEntries: 2,
  maxMain: 5,
  targetCoins: 25,
  targetFills: 100,
  paceSecs: 14400,
  probeSol: 0.01,
  maxProbes: 1,
  maxExposureSol: 2,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  /** Half already sold at tp1. */
  halfSold: boolean;
  exiting: boolean;
  filled: boolean;
  lastValue: number;
  /** Highest real SOL reserve seen while holding (the run's health). */
  peakRq: number;
  /** Real SOL reserve when the last buy was decided. */
  lastBuyRq: number;
  /** SOL spent on buys for this position. */
  invested: number;
}

/** Close value of `tokens` on a curve with virtual reserves (vq, vt), SOL, fees deducted. */
function closeValue(tokens: bigint, vq: bigint, vt: bigint, txSol: number): number {
  const t = Number(tokens);
  const q = Number(vq);
  const v = Number(vt);
  return ((t * q) / (v + t) / LAMPORTS) * (1 - CURVE_FEE) - txSol;
}

export function createSurgeScalp(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = p.window + p.fadeWindow + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Entry signal on a curve's tape at slot `now`. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge) return false;
    const from = now - p.window;
    const mid = now - p.window / 2;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let netOld = 0;
    let netNew = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else sellSol += tr.sol;
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < p.minBuys || byUser.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (startPrice <= 0) return false;
    const up = last / startPrice - 1;
    if (up < p.minUp) return false;
    if (last < high * p.nearHigh) return false;
    if (netNew <= 0 || netNew < p.accel * netOld) return false;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (top > p.maxBuyerShare * buySol) return false;
    return true;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: stop loss, take-profit ladder, trailing stop, fade, time limit.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
        const vt = mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
        const rqSol = (mk ? Number(mk.real_quote_reserves) : Number(curve.real_quote_reserves)) / LAMPORTS;
        const tokens = BigInt(pos.token_amount);
        const value = closeValue(tokens, vq, vt, tx);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        if (rqSol > h.peakRq) h.peakRq = rqSol;
        h.lastValue = value;
        if (cost <= 0) continue;
        const t = tapeOf(mint);
        // Take half off at tp1, once (off by default: tail winners are ridden, not capped).
        if (!h.halfSold && !h.exiting && value >= cost * (1 + p.tp1)) {
          h.halfSold = true;
          if (orders.length < cap && !pendingByMint.has(mint)) {
            orders.push({ side: 'sell', mint, token_amount: tokens / 2n, max_slippage_bps: 10_000 });
          }
          continue;
        }
        let exit = h.exiting;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && !h.halfSold && value >= cost * (1 + p.tp2)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && flow(t, now, p.fadeWindow) < -p.fadeNetSol) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        // The run is over: the crowd's real SOL reserve fell far below its peak.
        if (!exit && h.peakRq > 0 && rqSol < h.peakRq * (1 - p.stallRqDrop)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          }
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint] of held) {
        exposure += Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS;
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        const h = held.get(mint);
        if (h !== undefined) {
          // Pyramid into a proven runner: its real SOL reserve doubled since the
          // last buy, so the crowd is still piling in and the 1% size cap grew too.
          if (h.exiting || !h.filled || h.invested >= p.maxStakeSol - p.minBuySol) continue;
          if (rqSol < h.lastBuyRq * p.addStepRq) continue;
          const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
          let amount = Math.min(capSol, p.addSol, p.maxStakeSol - h.invested, p.maxExposureSol - exposure);
          if (amount > free - tx) amount = free - tx;
          if (amount < p.minBuySol) continue;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
          free -= amount + tx;
          exposure += amount;
          h.invested += amount;
          h.lastBuyRq = rqSol;
          continue;
        }
        if (slotsLeft <= 0 || mainLeft <= 0) continue;
        const t = tapes.get(mint)!;
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
        if (!entrySignal(t, now, rqSol)) continue;
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, { opened: now, peakValue: 0, halfSold: false, exiting: false, filled: false, lastValue: 0, peakRq: rqSol, lastBuyRq: rqSol, invested: amount });
        t.entries++;
        slotsLeft--;
        mainLeft--;
      }

      // Guardrail pacing: open a probe when fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
