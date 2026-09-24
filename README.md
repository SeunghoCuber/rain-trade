# RainTrade

Paper-trading harness for market making on Polymarket "Bitcoin Up or Down — 15 min" markets.

- Design: [docs/PLAN.md](docs/PLAN.md)
- Build phases: [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)
- Verified venue facts (fees, resolution, book behavior): [docs/VERIFIED.md](docs/VERIFIED.md)
- Dashboard design reference: [docs/DESIGN.md](docs/DESIGN.md)

## Setup

Requires Node 24+ (TypeScript runs natively, no build step) and pnpm via corepack.

```sh
corepack enable
pnpm install
pnpm check          # typecheck + lint + tests
```

## Layout

```
config/default.yaml       sweepable config, validated by zod (packages/pm-harness-core/src/config.ts)
packages/
  pm-harness-core/        event schemas, sim types, NDJSON codec, config, Chainlink TWAP
  pm-harness-feeds/       Polymarket / spot / Chainlink adapters      (Phase 1)
  pm-harness-sim/         fill simulator, fee + rebate model
  pm-harness-strategy/    fair value + market maker                   (Phases 4, 6)
  pm-harness-analytics/   markouts, stats, report                     (Phase 8)
apps/
  harness-live/           live paper runner                           (Phase 11)
  harness-replay/         backtest + sweep CLI                        (Phases 6, 10)
  harness-dashboard/      Vite + React dashboard (`pnpm --filter harness-dashboard dev`)
docs/samples/             raw API/WebSocket captures backing docs/VERIFIED.md
```
