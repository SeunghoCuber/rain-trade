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
pnpm recorder                       # foreground (keeps the Mac awake while running)
ops/install-recorder.sh             # macOS: recorder + compaction + health under launchd
ops/install-recorder.sh uninstall
tail -f data/recorder.log           # logs
cat data/status.json                # per-feed health, refreshed every 10 s
pnpm recorder:stats 2026-09-25      # per-market coverage, gaps, resolution, TWAP cross-check
```

**Keep the Mac awake:** the recorder holds a `caffeinate -is` assertion for as long as it runs (`recorder.preventSleep`). `-i` blocks idle sleep, and `-s` blocks system sleep **only on AC power**. Closing the lid sleeps a laptop unless it is plugged in with an external display (clamshell mode). Markets recorded across a sleep are flagged `GAP` and excluded, so sleep costs data, not correctness.

**macOS launchd setup** (`ops/install-recorder.sh` installs three agents):

| Agent | Runs | Log |
|---|---|---|
| `com.raintrade.recorder` | always; restarted within ~1 s of any exit; starts at login | `data/recorder.log` |
| `com.raintrade.compact` | hourly at :07 (a run missed during sleep fires on wake) | `data/compact.log` |
| `com.raintrade.health` | every 6 h (01:20, 07:20, 13:20, 19:20 local time) | `data/health.log` |

Check it with `launchctl print gui/$(id -u)/com.raintrade.recorder | grep -E "state|pid|last exit"`.

Two macOS permission problems, both because the repo lives in `~/Documents` (a privacy-protected folder):
- **node needs access to `~/Documents`.** Grant it under System Settings → Privacy & Security → Full Disk Access, adding the node binary that `command -v node` prints. **Re-grant it after upgrading node with nvm**, because the path changes. Without it, jobs hang silently or exit 78.
- **launchd can't open a log file created by another app** (for example one made by running `pnpm recorder >> data/recorder.log` from a terminal or editor). The agent then fails with `last exit code = 78: EX_CONFIG`. The fix is to move that log aside (`mv data/recorder.log data/recorder-old.log`) and reinstall, so launchd creates the file itself.

Set `recorder.alertWebhookUrl` in the config to get feed-down / recovered alerts (POST `{"text": ...}`, works with Slack or ntfy).

Storage notes: only the UP side of the unified book is stored (`recorder.dropMirrored`); the DOWN book is its mirror (DOWN bid at 1−p = UP ask at p). Trades are stored for both tokens. See [docs/VERIFIED.md](docs/VERIFIED.md).

## Data store (Phase 2)

Closed raw hours are compacted into Parquet (one table per event type, `data/parquet/<table>/date=…/HH.parquet`, about 15 MB/hour; the gain is query speed, not size). DuckDB queries them in place.

```sh
pnpm data:compact                 # compact closed hours not done yet (idempotent; --force to redo)
pnpm data:health [YYYY-MM-DD…]    # per-market health → data/health/ (default: yesterday + today)
pnpm data:sql                     # row count per view
pnpm data:sql "SELECT slug, outcome, flags, excluded FROM markets ORDER BY window_start"
```

Views:
- **Events:** `book_deltas`, `book_levels` (snapshots, one row per level), `trades`, `spot`, `res_prices`, `market_opens`, `market_closes`, `resolutions`, `feed_gaps`, `tick_size_changes`, `venue_raw`.
- **Derived:** `market_health`, and `markets` (one row per market: metadata, official outcome and health).
- **Ordering:** `ORDER BY recv_ts, date, hour, line` reproduces the recorded order exactly.

A market is **excluded** from headline stats if it's flagged `NOCLOB`, `LATE`, `GAP`, `NORES` or `SETTLE`. `CLTICKS` and `TWAPΔ` are informational. See `packages/pm-harness-store/src/health.ts`.

On the Mac, run `pnpm data:compact` by hand. On a server, systemd timers run compaction hourly and health daily; see [docs/DEPLOY-AWS.md](docs/DEPLOY-AWS.md).

## Replay (Phase 3)

```sh
pnpm replay                                   # everything recorded, with book verification + digest
pnpm replay --from 2026-09-25T01:00Z --to 2026-09-25T02:00Z
pnpm replay --market btc-updown-15m-1790298000
pnpm replay --parquet                         # read compacted tables instead of raw (same digest)
```

It prints event counts, how well the rebuilt order books match the venue (every snapshot and every reported best bid/ask), and a sha256 digest. The same data always gives the same digest.

## Backtest (Phase 6)

```sh
pnpm fv:calibrate                               # fair value vs Polymarket mid: Brier, reliability, lead/lag
pnpm backtest --run-id mm-v1                    # all recorded data, all three fill modes
pnpm backtest --from 2026-09-25T00:00Z --to 2026-09-26T00:00Z --strategy none
```

```sh
pnpm analyze mm-v1                              # PLAN §7 stats, bootstrap CIs, markouts, breakdowns → analysis.json
pnpm sanity                                     # PLAN §9 invariants on closed hours (exit 1 on failure)
```

Outputs go to `data/runs/<runId>/`: `fills.parquet`, `markets.parquet` (per market × mode: PnL decomposition, rebate, uptime), `fv.parquet` (FV every 250 ms), `quotes.parquet` and `run.json` (config + results digest).

## Dashboard (Phase 9)

```sh
pnpm dashboard                                  # build UI + serve on http://127.0.0.1:8787
pnpm dashboard:api & pnpm --filter harness-dashboard dev   # dev mode with hot reload (Vite proxies /api)
```

It reads `data/runs/*` (run `pnpm backtest` first) and `data/analysis/fv_samples.parquet` (from `pnpm fv:calibrate`). The analysis is recomputed automatically when a run is newer than its `analysis.json`.

## Layout

```
config/default.yaml       sweepable config, validated by zod (packages/pm-harness-core/src/config.ts)
packages/
  pm-harness-core/        event schemas, config, codec, TWAP, event clock, order book, market state, RNG
  pm-harness-feeds/       Gamma discovery, reconnecting WS, CLOB / Chainlink / spot normalizers
  pm-harness-store/       Parquet compaction, DuckDB views, per-market health, replay source
  pm-harness-sim/         fill simulator, fee + rebate model
  pm-harness-strategy/    fair value + market maker                   (Phases 4, 6)
  pm-harness-analytics/   markouts, stats, report                     (Phase 8)
apps/
  harness-recorder/       market discovery + recorder + stats CLI
  harness-live/           live paper runner                           (Phase 11)
  harness-replay/         backtest + sweep CLI                        (Phases 6, 10)
  harness-dashboard/      React + Recharts dashboard and its JSON API (server/main.ts)
ops/                      launchd agent (Mac), systemd units (Linux), venue latency probe
docs/samples/             raw API/WebSocket captures backing docs/VERIFIED.md
```
