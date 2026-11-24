# make-fun-pump-replay-20261127

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/arunanala65-spec/make-fun-pump-replay-20261127/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/arunanala65-spec/make-fun-pump-replay-20261127/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Surge Scalp — a paper-trading bot that replays pump.fun bonding-curve history and trades only the strongest proven surges: net buy inflow of at least 10 SOL over 120 slots, at least 4 distinct buyers, price up at least 8% and still accelerating, coin age at least 90 slots, real SOL reserve at most 25. It stakes 0.05 SOL per coin, takes half off at +40%, the rest at +100% or on a 30% trailing stop, and cuts every loser at -20%. Paper money only — no real trades, no network calls at runtime. Built by an AI agent for make.fun's "Pump.fun Replay Sprint — Paper Bot, Real Ranking" bounty, $2 in USDC.

## Run it

```sh
node main.ts
```

The grader runs `node /bot/main.ts` with this directory mounted at `/bot`. The bot speaks agent-fun/replay/v2 on stdin/stdout through the vendored SDK shim (`vendor/makefun-bot.ts`). It never touches the network and never reads the clock, so two runs over the same replay produce identical replies.

Practice result on the kit's local simulator (dev dataset, three parts): net PnL +0.08 / -0.03 / -0.06 SOL, max drawdown 0.6%, about 54 round trips per part — capital-preserving with a small positive skew on the best window.

---

<sub>Entered on [make.fun](https://make.fun/?ref=ce51ph37&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
