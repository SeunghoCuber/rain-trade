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

## Recorder (Phase 1)

Records Polymarket books/trades, Chainlink, Binance and Coinbase into `data/raw/YYYY-MM-DD/HH.ndjson` (closed hours gzipped, ~0.5 GB/day).

```sh
pnpm recorder                       # foreground, wrapped in caffeinate on macOS
ops/install-recorder.sh             # macOS: run under launchd (restart on crash, no idle sleep)
ops/install-recorder.sh uninstall
tail -f data/recorder.log           # logs
cat data/status.json                # per-feed health, refreshed every 10 s
pnpm recorder:stats 2026-09-25      # per-market coverage, gaps, resolution, TWAP cross-check
```

**Keep the Mac awake:** both `pnpm recorder` and the launchd agent run under `caffeinate -is`. `-i` blocks idle sleep, and `-s` blocks system sleep **only on AC power**. Closing the lid still sleeps a laptop. For the 3-week recording, keep it plugged in with the lid open, or run it on an always-on machine or VPS.

Set `recorder.alertWebhookUrl` in the config to get feed-down / recovered alerts (POST `{"text": ...}`, works with Slack or ntfy).

Storage notes: only the UP side of the unified book is stored (`recorder.dropMirrored`); the DOWN book is its mirror (DOWN bid at 1−p = UP ask at p). Trades are stored for both tokens. See [docs/VERIFIED.md](docs/VERIFIED.md).

## Layout

```
config/default.yaml       sweepable config, validated by zod (packages/pm-harness-core/src/config.ts)
packages/
  pm-harness-core/        event schemas, sim types, NDJSON codec, config, Chainlink TWAP
  pm-harness-feeds/       Gamma discovery, reconnecting WS, CLOB / Chainlink / spot normalizers
  pm-harness-sim/         fill simulator, fee + rebate model
  pm-harness-strategy/    fair value + market maker                   (Phases 4, 6)
  pm-harness-analytics/   markouts, stats, report                     (Phase 8)
apps/
  harness-recorder/       market discovery + recorder + stats CLI
  harness-live/           live paper runner                           (Phase 11)
  harness-replay/         backtest + sweep CLI                        (Phases 6, 10)
  harness-dashboard/      Vite + React dashboard (`pnpm --filter harness-dashboard dev`)
ops/                      launchd agent for the recorder
docs/samples/             raw API/WebSocket captures backing docs/VERIFIED.md
```
