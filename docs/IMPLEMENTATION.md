# RainTrade: Implementation Phases

This document breaks the design in [PLAN.md](PLAN.md) into phases for building RainTrade. Section references (for example §4.5) point to PLAN.md.

**Guiding principle:** get the recorder running first. The 3 weeks of data recording is the longest part of the project, and every other phase runs in parallel with it. Each phase ends with an exit check that must pass before the next phase depends on it.

---

## Phase 0: Check the unknowns and set up the repo (~2 days)

> **Status: done (2026-09-24).** Findings are in [VERIFIED.md](VERIFIED.md). Three of them change later phases:
> - **Phase 1:** the CLOB feed is about 420 msg/s per market. Store one side of each mirrored delta, compactly (~10× smaller).
> - **Phase 1:** Binance's main endpoints are geo-blocked here. Use `data-stream.binance.vision` and treat Coinbase as a first-class source.
> - **Phases 4 and 6:** Gamma publishes S₀ about 20 min late, so S₀ and settlement are computed from Chainlink ticks with `chainlinkTwap()`.

§3 lists three unknowns. Each one changes how the recorder and simulator are built, so they are answered before any code depends on them.

- **Check the unknowns:**
  - (a) Which price source the market resolves against, and how the opening and closing prices are sampled.
  - (b) Whether the Up book already shows Down liquidity at 1−q.
  - (c) The current taker-fee formula and rebate rules.
  - Also record the settlement tie rule and the tick size.
  - Write the answers in `docs/VERIFIED.md`, citing raw API or WebSocket samples.
- **Set up the repo:** pnpm workspaces with the package and app layout from §5, TypeScript strict mode, vitest, eslint, and YAML config checked with zod.
- **Define the core types** from §6 (`MarketEvent`, the payload schemas for each event kind, `SimOrder`, `SimFill`, `MarketResult`) in `pm-harness-core`.

**Exit check:** raw payload samples are saved for every source, and each §3 unknown has a written answer.

---

## Phase 1: Market discovery and recorder (~5 days), then start recording

> **Status: built (2026-09-24); the 24-hour exit check is still pending.** The code is in `apps/harness-recorder` and `packages/pm-harness-feeds`. Run it with `pnpm recorder` or `ops/install-recorder.sh`, and check it with `pnpm recorder:stats <day>`. Additions beyond the original plan:
> - **Event kinds:** `tick_size_change` (the venue shrinks the tick near 0.99/0.01) and `venue_raw` (unknown venue messages kept verbatim).
> - **Chainlink backfill:** ticks replayed by RTDS on resubscribe are stored with `backfill: true`.
> - **Coverage from the data:** stats measure holes from the recorded data itself, so restarts and sleep are caught even without `feed_gap` events.
> - **Settlement cross-check in stats:** our Chainlink TWAP is compared with Gamma's `priceToBeat`/`finalPrice` for every market (the `TWAPΔ` flag).

- **Discovery:** poll every 30 s, register the next market at least 60 s before it opens, and emit `market_open` / `market_close` events.
- **Feed adapters:** the Polymarket market WebSocket (both Up and Down tokens), the spot WebSocket (Binance and/or Coinbase), and the resolution-source price feed.
- **Normalization:** convert every event to `MarketEvent` with two timestamps: `exchangeTs` from the source and `recvTs` from the local monotonic clock in nanoseconds.
- **Storage:** append-only NDJSON files, rotated hourly.
- **Feed health:** handle reconnects and detect sequence breaks and gaps, emitting `feed_gap` events.
- **Operations:** run it as a long-lived process (launchd, pm2 or a small VPS), with basic alerting when a feed goes silent.

**Exit check:** the recorder runs for 24 hours unattended, and the number of recorded markets matches the number expected (about 96 per day).

**Milestone: start continuous recording.** The 3-week data clock starts here.

---

## Phase 2: Storage and data health (~3 days)

> **Status: done (2026-09-25).** The code is in `packages/pm-harness-store`; use `pnpm data:compact | data:health | data:sql`. Exit check met: `pnpm data:sql` returns per-market event counts, and `markets.excluded` flags bad markets. Overnight, 21 of 22 closed markets were usable, and the one left was only waiting for its resolution. Deploy files for AWS are in `ops/systemd` and [DEPLOY-AWS.md](DEPLOY-AWS.md). Findings:
> - **Storage:** Parquet is about 15 MB/hour next to about 20 MB of raw gz, so together about 0.85 GB/day. Compaction takes about 3 s per hour of data.
> - **RTDS reproduces the official TWAP only to ≤ ~$0.70**, not exactly ([VERIFIED.md](VERIFIED.md) §2.1). Settlement uses Gamma's official outcome, and our TWAP is only the real-time S₀ estimate.
> - **RTDS stalls (~7 s, about every 45 min) are upstream** and no longer exclude markets. `GAP` now counts only book and spot holes plus recorder downtime, measured from any-feed silence.

- A nightly job that compacts NDJSON into Parquet. DuckDB can query NDJSON directly, so this job can slip without blocking anything.
- A DuckDB view layer over the recorded data.
- A daily health report:
  - Gaps and reconnects.
  - Markets with a gap longer than N ms, flagged for exclusion.
  - Our computed settlement compared against the official Polymarket resolution.

**Exit check:** a DuckDB query returns clean per-market event counts, and markets with gaps are flagged.

---

## Phase 3: Event clock and replay (~4 days)

> **Status: done (2026-09-25).** Code: `pm-harness-core` (`ReplayClock`, `LiveClock`, `runReplay`, `AsyncEventQueue`, `Book`, `MarketStates`, `Rng`, `canonicalEvent`), `pm-harness-store/replay.ts`, `apps/harness-replay` (`pnpm replay`). Exit check on 10M recorded events:
> - **Books:** best bid/ask agrees with the venue on 99.9995% of level changes. Snapshot differences near the top of the book are rare and explained ([VERIFIED.md](VERIFIED.md) §3).
> - **Determinism:** two full replays give identical digests.
> - **Lossless compaction:** Parquet and raw replays give identical digests.
>
> Findings that changed the design:
> - **Matches remove maker liquidity silently.** The book prunes levels using the reported best bid/ask.
> - **The venue reports an empty side as 0 / 1**, not as missing.
> - **A recorder restart shows up in the data as a second `market_open`** for the same market, so replay stops trusting that book until the next snapshot.
> - **Snapshots need their level order stored** (`book_levels.idx`) for byte-identical replays.
> - **Raw replay is about 2.3× faster than Parquet** for full sequential runs (~300k vs ~130k events/s), so `pnpm replay` reads raw by default.
>
> Deferred to Phase 11: connecting the live feeds to an `AsyncEventQueue`. The interfaces (`LiveClock`, queue, `runReplay`-style handler) are in place.

- **Event clock:** gives the engine one ordered stream of events. It has two sources behind the same interface: the live recorder, or a file replay that merges sources in `recvTs` order (§4.7).
- **Book reconstruction:** apply snapshots and deltas to get the book state for each token.
- **Determinism:** a seeded random number generator for anything random, so replays are fully deterministic.

**Exit check:** replaying a recorded day rebuilds books that match the recorded snapshots at every snapshot point, and two replays produce byte-identical output (sanity check #7).

---

## Phase 4: Fair value engine (~3 days)

> **Status: done (2026-09-25).** Code: `pm-harness-strategy/src/fair-value.ts`; run the calibration with `pnpm fv:calibrate`.
> - **The model prices the verified payoff:** closing 60 s Chainlink TWAP ≥ S₀. It doesn't use the plain spot digital: ticks already observed in the closing window are fixed, and future ticks add variance. The price level is spot mid × a tracked spot-to-Chainlink basis, and S₀ is our TWAP, with RTDS noise as a floor.
> - **Calibration on the first 32 resolved markets:**
>   - **Brier score:** FV 0.1388 vs Polymarket mid 0.1372, about 1% worse overall, within noise at this sample size. FV is better at 5–10 min left.
>   - **Lead/lag:** corr(ΔFV_t, Δmid_{t+1s}) = 0.25 vs 0.06 at −1 s, so **FV leads the market mid by about 1 s**.
> - **Output:** samples are saved to `data/analysis/fv_samples.parquet` for chart V8.

- An EWMA estimate of volatility from 1-second log returns, blending the 60 s and 600 s half-lives.
- The digital-option fair value Φ(ln(S/S₀)/σ√τ), taking S₀ from the resolution source (§4.3).
- `FairValue` logged for every tick.
- An early calibration check on the data recorded so far: a reliability diagram and a Brier score against the Polymarket mid (a cheap first version of §7.5).

**Exit check:** the fair value is roughly calibrated on recorded data. If the Polymarket mid clearly beats it, the model is fixed before anything is built on top of it.

---

## Phase 5: Fill simulator (~6 days)

> **Status: done (2026-09-25).** Code: `pm-harness-sim/src/fill-sim.ts`. Each fill rule (1–7) and each lifecycle transition has a test, including PLAN.md's sequence diagram (the toxic fill during cancel latency) reproduced exactly. How the design follows from the verified venue facts:
> - **Orders are in UP terms** (the book is unified), and DOWN prints count against UP queues at 1−p.
> - **Queue accounting:** a trade at our price reduces the queue directly, since the feed sends no level update for consumed liquidity. A later level decrease is counted as cancels **net of those prints**, so nothing is counted twice. The mode's `cancelsAheadFrac` decides how many cancels were ahead of us. Level increases join behind us. The queue ahead is capped at the displayed size (× the pad).
> - **Book robustness:** a missing reported best is now treated as unknown, not as an empty side (the venue sends 0 / 1 for empty).

This is the most important phase: paper-trading results are only as good as the fill model.

- The order state machine from §4.5, with its ack and cancel latencies.
- Queue tracking: trades at our price level, trades through our level, and the cancel rules for each of the three modes.
- Post-only rejection (`RejectedCross`).
- Complementary matching, switched by config based on the Phase 0 answer to (b).
- The optimistic, base and pessimistic modes run side by side over one event stream.
- Unit tests for every rule, including the toxic-fill sequence diagram from §4.5 written as a test.

**Exit check:** every lifecycle transition and every fill rule (1 to 7) has a passing test.

---

## Phase 6: Strategy, ledger and settlement (~4 days)

> **Status: done (2026-09-25).** Code: `pm-harness-strategy` (`MarketMaker`, `BacktestRunner`), `pm-harness-sim/ledger.ts`, `pnpm backtest`, with outputs in `data/runs/<runId>/{fills,markets,fv,quotes}.parquet`.
> - **Exit check:** a replay of everything recorded (11.4M events, 78 s) produced a MarketResult for all 35 resolved markets. The §7.1 decomposition identity holds to 5e-13.
> - **Design choices:**
>   - Settlement uses the **official** outcome (the Phase 2 finding).
>   - The vol spread term uses |FV(S·e^{σ√h}) − FV(S)| with h = 5 s. That is PLAN's σ√τ converted into probability units, so it widens where FV is most sensitive.
>   - An UP ask with no UP inventory is a DOWN bid at 1−p, and pairs are merged for $1.
>   - Rebate ≈ 20% of our maker fee-equivalent.

- **Market maker (§4.4):** half-spread plus the volatility term, inventory skew, the inventory cap, cancelling everything before close, and cancelling when spot jumps.
- **Ledger (§4.6):** cash, Up shares and Down shares per market, an optional merge, a pluggable fee function, and a rebate estimate kept separate from trading PnL.
- **Settlement:** a cross-check against the official resolution that logs `SettlementMismatch` when they differ.
- **Replay CLI** (`harness-replay`): writes orders, fills and per-market results to DuckDB.

**Exit check:** a full-day replay runs end to end and produces a `MarketResult` for each market.

---

## Phase 7: Sanity-check suite (~3 days)

> **Status: done (2026-09-25).** Run with `pnpm sanity`, which exits 1 on any failure. CI versions on synthetic markets (with informed takers) are in `pm-harness-strategy/src/sanity.test.ts`. On all recorded data (11.5M events):
>
> | # | Check | Result |
> |---|---|---|
> | 1 | decomposition identity | PASS, error 5e-13 |
> | 2 | zero strategy | PASS, exactly 0 |
> | 3 | random quotes | PASS: spread+adverse −0.90¢/share (base), −1.63¢ (pessimistic) |
> | 4 | perfect foresight | PASS: adverse +1.79¢/share vs mm −0.46¢ |
> | 5 | settlement vs official | PASS, 32/32 |
> | 6 | size impact | **FLAG**: only 44% of quote levels have quoteSize < 20% of displayed size |
> | 7 | determinism | PASS, identical digests |
>
> - **Check 6 means** a 50-share quote is often a large part of its level, so "our size doesn't move the market" is shaky at this size. Sweep `quoteSize` downward, or keep it as a stated caveat in the go/no-go report.
> - **Still open:** the exit check asks for one week of data, and we have about 12 h so far. Re-run `pnpm sanity` once more is recorded.
> - **Pinned data range:** `pnpm sanity` defaults to closed hours only (`--to` = the start of the current hour), because the live recorder appends to the current hour while the suite runs.

The checks from §9, run in CI and failing the run on any violation:

1. The decomposition identity.
2. The zero-strategy test.
3. The random-quote test.
4. The perfect-foresight test.
5. The settlement match rate of at least 99.9%.
6. The size-impact check.
7. Replay determinism.

The zero-strategy and determinism tests should be written during Phases 3 to 6, not saved for this phase.

**Exit check:** all 7 checks pass on at least one week of recorded data.

---

## Phase 8: Analytics core (~5 days)

- PnL decomposition for each fill at several horizons (§7.1), and markout curves (§7.2).
- The core stats from §7.3, and breakdowns by every dimension in §7.6.
- A block bootstrap that resamples whole days (10k draws), the t-stat, and the probability that the edge is positive (§7.4). This is in TypeScript; a Python notebook is optional later.

**Exit check:** a single command prints the full stats table, with confidence intervals, for any run and fill mode.

---

## Phase 9: Dashboard (~7 days)

- A small API over DuckDB, plus a React and Recharts front end with the layout from §8.
- **Build order:**
  1. The KPI row, V1, V2, V3, V12, then the market table with the V7 drill-down. These answer "is there an edge, and why?".
  2. Then V4, V5, V6, V8, V9 and V11.
  3. V10 waits until Phase 10, when sweep results exist.

**Exit check:** every chart except V10 renders from real replay data, and clicking a market row opens V7.

---

## Phase 10: Sweeps, out-of-sample testing and the go/no-go report (~4 days)

- A sweep runner that runs N configs in parallel (worker threads) over the same event stream.
- A 70/30 split by day: parameters are chosen on the first 70%, and only the out-of-sample results are reported, together with how many configs were tried.
- The V10 heatmap, with a plateau check.
- A go/no-go report generator that evaluates every criterion in §10 in pessimistic mode, on out-of-sample data.

**Exit check:** after about 3 weeks of recorded data, the report produces a pass or fail for each criterion.

---

## Phase 11: Live paper runner (~2 days, can run in parallel from Phase 6 on)

- `harness-live` connects the live event clock to the same engine and writes results to DuckDB as they happen.
- A rolling 7-day edge monitor and a kill switch.
- A measurement of the real WebSocket round-trip latency (a mitigation from §12). The result feeds back into the latency settings for each fill mode.

---

## Timeline

| Weeks | Engine and analytics work | Data recording |
|---|---|---|
| 1 | Phase 0, Phase 1 | recording starts |
| 2 | Phases 2, 3, 4 | ~1 week of data |
| 3 | Phase 5 | ~2 weeks |
| 4 | Phases 6, 7 | ~3 weeks, minimum sample reached |
| 5–6 | Phases 8, 9 | growing |
| 6–7 | Phase 10, then the go/no-go review | enough for the 70/30 split |

### Differences from the PLAN.md Gantt chart (§11)

- **Phase 0 is added**, so the §3 unknowns are answered before code depends on them.
- **Parquet compaction no longer blocks anything**, because DuckDB can read NDJSON directly.
- **Sanity tests are written alongside the engine phases** instead of being left for a block at the end.
