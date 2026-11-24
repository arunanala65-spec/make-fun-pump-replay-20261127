// Surge Scalp — entry for make.fun's "Pump.fun Replay Sprint — Paper Bot, Real Ranking"
// (u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122).
//
// Run by the grader as `node /bot/main.ts` with this directory mounted at /bot.
// The bot speaks agent-fun/replay/v2 on stdin/stdout through the vendored SDK shim
// (vendor/makefun-bot.ts, a byte-identical copy of the kit's sdk/ts/makefun-bot.ts).
// It never touches the network and never reads the clock: every decision comes from
// the batch stream alone, so two runs over the same replay produce identical replies.
//
// Strategy (see strategy.ts for the full reasoning and the measurements behind it):
// buy only the strongest proven surges — net buy inflow >= 10 SOL over 120 slots,
// >= 4 distinct buyers, price up >= 8% and still accelerating, coin age >= 90 slots,
// real SOL reserve <= 25 — stake 0.05 SOL, take half off at +40%, the rest at +100%
// or on a 30% trailing stop, cut at -20%. Practice result on the kit's local
// simulator (dev dataset, three parts): net PnL +0.08 / -0.03 / -0.06 SOL, max
// drawdown 0.6%, ~54 round trips per part — capital-preserving, small positive skew.

import { runBot } from './vendor/makefun-bot.ts';
import { createSurgeScalp, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createSurgeScalp(DEFAULT_PARAMS));
