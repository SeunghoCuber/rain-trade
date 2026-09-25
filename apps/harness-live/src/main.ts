// Live paper trading (Phase 11): `pnpm live [config]`
// The same engine as the backtests (BacktestRunner: strategy + fill simulator + ledger per fill
// mode), driven by the live feeds on a wall clock. No orders are sent anywhere.
// Outputs, per settled market (≈20 min after close, when the official result is published):
//   data/live/<runId>/{markets,fills,fv,quotes}.ndjson   append-only
//   data/runs/<runId>/*.parquet + run.json + analysis.json   refreshed ≤ every 10 min → dashboard, pnpm analyze
//   data/live/status.json                                 every 10 s
// Kill switch: data/live/KILL (manual), drawdown, rolling 7-day edge (config live.killSwitch).

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { AsyncEventQueue, LiveClock, loadConfig, makeRecvClock, type MarketEvent } from "@rain/pm-harness-core";
import { LiveFeeds, type FeedHooks } from "@rain/pm-harness-feeds";
import { BacktestRunner, MarketMaker, type FillRow, type MarketResultRow } from "@rain/pm-harness-strategy";
import { GatedStrategy, KillSwitch, type SettledMarket } from "./kill-switch.ts";

const cfg = loadConfig(process.argv[2] ?? "config/default.yaml");
const runId = "live";
const outDir = join(cfg.live.outDir, runId);
const runOut = join(cfg.recorder.dataDir, "runs", runId);
mkdirSync(outDir, { recursive: true });
const killFile = join(cfg.live.outDir, "KILL");
const log = (level: "info" | "warn" | "error", msg: string) =>
  (level === "info" ? console.log : console.error)(`${new Date().toISOString()} ${level.toUpperCase()} ${msg}`);

// history for the kill switch (pessimistic net PnL per settled market)
const history: SettledMarket[] = [];
const marketsFile = join(outDir, "markets.ndjson");
if (existsSync(marketsFile)) {
  for (const l of readFileSync(marketsFile, "utf8").split("\n")) {
    if (!l) continue;
    const r = JSON.parse(l) as { mode: string; window_start: number; pnl_trading: number; rebate_est: number; fees: number; volume_filled: number };
    if (r.mode === "pessimistic") history.push({ windowStart: r.window_start, pnl: r.pnl_trading + r.rebate_est - r.fees, volume: r.volume_filled });
  }
}
const kill = new KillSwitch(cfg, killFile, history);

const recvTs = makeRecvClock();
const clock = new LiveClock(recvTs);
const startedMs = Date.now();
const runner = new BacktestRunner({ cfg, clock, modes: cfg.live.modes, strategy: () => new GatedStrategy(new MarketMaker(cfg), kill) });
const queue = new AsyncEventQueue<MarketEvent>();
const feedState = new Map<string, { connected: boolean; lastEventMs: number | null; events: number }>();
const feedRow = (n: string) => feedState.get(n) ?? feedState.set(n, { connected: false, lastEventMs: null, events: 0 }).get(n)!;

const hooks: FeedHooks = {
  emit: (ev) => queue.push(ev),
  recvTs,
  now: () => Date.now(),
  onState: (feed, connected, detail) => {
    feedRow(feed).connected = connected;
    log(connected ? "info" : "warn", `${feed} ${connected ? "connected" : `disconnected (${detail})`}`);
  },
  onGap: (feed, gapMs, reason) => gapMs > cfg.recorder.maxGapMs && log("warn", `${feed} gap ${gapMs}ms (${reason})`),
  onEvents: (feed, n) => {
    const f = feedRow(feed);
    f.events += n;
    f.lastEventMs = Date.now();
  },
  onParseError: (feed, err) => log("error", `${feed} parse error: ${err.message}`),
  onUnknownType: () => {},
  onMirrorMismatch: () => {},
};
const feeds = new LiveFeeds({ cfg, hooks, log, onMarketRetire: (m) => feedState.delete(`clob:${m.slug}`) });

// persistence (snake_case columns = the backtest run layout, so analytics + dashboard read both)
const append = (file: string, rows: object[]) => rows.length && appendFileSync(join(outDir, file), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const fillOut = (f: FillRow) => ({
  mode: f.mode, fill_id: `${f.fillId}@${startedMs}`, order_id: f.orderId, market_id: f.marketId, side: f.side, price: f.price, size: f.size, ts: f.ts,
  seconds_to_close: f.secondsToClose, fv_at_fill: f.fvAtFill, sigma_at_fill: f.sigmaAtFill, inventory_before: f.inventoryBefore,
  during_cancel_latency: f.duringCancelLatency, through: f.through, queue_ahead_at_live: f.queueAheadAtLive, spot_move_1s_bp: f.spotMove1sBp,
  book_bid: f.bookBid, book_ask: f.bookAsk, fv_h5: f.fvH5, outcome: f.outcome,
});
const marketOut = (r: MarketResultRow, partial: boolean) => ({
  mode: r.mode, market_id: r.marketId, slug: r.slug, window_start: r.windowStart, outcome: r.outcome, pnl_trading: r.pnlTrading, pnl_spread: r.pnlSpread,
  pnl_adverse: r.pnlAdverse, pnl_inventory: r.pnlInventory, rebate_est: r.rebateEst, fees: r.fees, volume_filled: r.volumeFilled, buy_volume: r.buyVolume,
  sell_volume: r.sellVolume, fills: r.fills, cancel_latency_fills: r.cancelLatencyFills, max_abs_inventory: r.maxAbsInventory, capital_used: r.capitalUsed,
  quote_uptime_pct: r.quoteUptimePct, realized_vol: r.realizedVol, decomp_error: r.decompError, live_partial: partial,
});

let persisted = 0;
let dirty = false;
function persistSettled(): void {
  if (runner.results.length === persisted) return;
  const fresh = runner.results.slice(persisted);
  persisted = runner.results.length;
  for (const id of new Set(fresh.map((r) => r.marketId))) {
    const rs = fresh.filter((r) => r.marketId === id);
    const partial = rs[0]!.windowStart < startedMs; // this process started after the window opened
    append("markets.ndjson", rs.map((r) => marketOut(r, partial)));
    append("fills.ndjson", runner.allFills().filter((f) => f.marketId === id).map(fillOut));
    append("fv.ndjson", (runner.fvSeries.get(id) ?? []).map((x) => ({ market_id: x.marketId, ts: x.ts, fv: x.fv, s: x.s, s0: x.s0, sigma: x.sigma, mid: x.mid })));
    append("quotes.ndjson", runner.quotes.filter((q) => q.marketId === id).map((q) => ({ mode: q.mode, market_id: q.marketId, ts: q.ts, bid: q.bid, ask: q.ask, fv: q.fv, inventory: q.inventory, bid_impact: q.bidImpact, ask_impact: q.askImpact })));
    const p = rs.find((r) => r.mode === "pessimistic");
    if (p) kill.add({ windowStart: p.windowStart, pnl: p.pnlTrading + p.rebateEst - p.fees, volume: p.volumeFilled });
    log("info", `settled ${rs[0]!.slug}${partial ? " (partial: started mid-window)" : ""}: ${rs.map((r) => `${r.mode} ${(r.pnlTrading + r.rebateEst).toFixed(2)}$/${r.fills} fills`).join(", ")}`);
    runner.forget(id);
  }
  if (kill.halted) log("warn", `KILL SWITCH: ${kill.halted} — quoting stopped`);
  dirty = true;
}

/** Rebuild data/runs/live/*.parquet from the NDJSON so `pnpm analyze live` and the dashboard see live results. */
async function exportRun(): Promise<void> {
  if (!dirty || !existsSync(marketsFile)) return;
  dirty = false;
  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();
  mkdirSync(runOut, { recursive: true });
  for (const t of ["markets", "fills", "fv", "quotes"]) {
    const src = join(outDir, `${t}.ndjson`);
    if (!existsSync(src)) continue;
    const dest = join(runOut, `${t}.parquet`);
    await conn.run(`COPY (SELECT * FROM read_json('${src}', format = 'newline_delimited')) TO '${dest}.tmp' (FORMAT parquet, COMPRESSION zstd)`);
    renameSync(`${dest}.tmp`, dest);
  }
  writeFileSync(join(runOut, "run.json"), JSON.stringify({ runId, strategy: "mm (live paper)", createdAt: new Date().toISOString(), live: true, simStats: Object.fromEntries(runner.modes.map((m) => [m.mode, m.sim.stats])), config: cfg }, null, 2));
  conn.closeSync();
  inst.closeSync();
}

function writeStatus(lagMs: number): void {
  const now = Date.now();
  const markets = feeds.activeMarkets.map((m) => ({
    slug: m.slug,
    inWindow: now >= m.windowStart && now < m.windowEnd,
    secondsLeft: Math.round((m.windowEnd - now) / 1000),
    fairValue: runner.fvEng.fairValue(m.marketId, now)?.p ?? null,
    inventory: runner.inventory(m.marketId),
    openOrders: Object.fromEntries(runner.modes.map((st) => [st.mode, st.sim.openOrders(m.marketId).map((o) => `${o.side} ${o.price}×${o.remaining} ${o.status}`)])),
  }));
  const status = {
    updatedAt: new Date(now).toISOString(),
    uptimeSec: Math.round((now - startedMs) / 1000),
    killSwitch: { halted: kill.halted, ...kill.stats(now) },
    processingLagMs: Math.round(lagMs),
    queued: queue.size,
    rttMs: feeds.rtt(),
    feeds: Object.fromEntries(feedState),
    markets,
    settledThisRun: new Set(runner.results.map((r) => r.marketId)).size,
    simStats: Object.fromEntries(runner.modes.map((m) => [m.mode, m.sim.stats])),
  };
  const f = join(cfg.live.outDir, "status.json");
  writeFileSync(`${f}.tmp`, JSON.stringify(status, null, 2));
  renameSync(`${f}.tmp`, f);
}

if (cfg.recorder.preventSleep && process.platform === "darwin") {
  const c = spawn("/usr/bin/caffeinate", ["-i", "-s", "-w", String(process.pid)], { stdio: "ignore" });
  c.on("error", () => {});
  c.unref();
}
feeds.start();
let lastLag = 0;
const timers = [
  setInterval(() => {
    kill.evaluate(Date.now());
    writeStatus(lastLag);
  }, cfg.live.statusIntervalSec * 1000),
  setInterval(() => void exportRun().catch((e: Error) => log("error", `export: ${e.message}`)), 10 * 60_000),
];
log("info", `live paper trading started: modes ${cfg.live.modes.join(",")}, output ${outDir}${kill.halted ? `; KILL SWITCH already tripped: ${kill.halted}` : ""}`);

let stopping = false;
async function shutdown(signal: string, code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  log("info", `${signal}: shutting down (open markets are not settled; their positions are dropped)`);
  for (const t of timers) clearInterval(t);
  feeds.stop();
  queue.close();
  persistSettled();
  await exportRun().catch(() => {});
  process.exit(code);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("uncaughtException", (e) => {
  log("error", `uncaught: ${e.stack ?? e.message}`);
  void shutdown("uncaughtException", 1);
});

for await (const ev of queue) {
  runner.handle(ev);
  lastLag = Date.now() - Number(ev.recvTs / 1_000_000n);
  if (ev.kind === "resolution") persistSettled();
}
