// Parameter sweep + out-of-sample evaluation (PLAN.md §7.4, §10):
//   pnpm sweep [--grid config/sweep.yaml] [--workers 4] [--id name] [--to ISO]
// 1. Runs every grid config over the same recorded data (worker threads, one replay pass each).
// 2. Splits markets 70/30 in time (by UTC day with ≥ 5 days, else by market) and ranks configs on
//    the IN-SAMPLE part only. 3. Checks the chosen config sits on a plateau (grid neighbours).
// 4. Re-runs the chosen config on the OUT-OF-SAMPLE part in all fill modes → run <id>-oos + analysis.
// Writes data/sweeps/<id>/sweep.json. `pnpm report <id>` turns it into the go/no-go report.

import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { DuckDBInstance } from "@duckdb/node-api";
import { analyzeRun, loadRun, mean, runDir, sum, tStat } from "@rain/pm-harness-analytics";
import type { FillMode } from "@rain/pm-harness-core";
import { computeDayHealth, createViews, writeHealth } from "@rain/pm-harness-store";
import { MarketMaker, type MarketResultRow } from "@rain/pm-harness-strategy";
import { backtest } from "../backtest-lib.ts";
import { expand, loadGrid, type Value } from "./grid.ts";
import type { WorkerInput, WorkerOutput } from "./worker.ts";

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const grid = loadGrid(opt("--grid") ?? "config/sweep.yaml");
const cfg = grid.base;
const dataDir = cfg.recorder.dataDir;
const sweepId = opt("--id") ?? `sweep-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}`;
// closed hours only: every worker must see identical data while the recorder appends
const toMs = opt("--to") ? Date.parse(opt("--to")!) : Math.floor(Date.now() / 3_600_000) * 3_600_000;
const points = expand(grid);
const nWorkers = Math.max(1, Math.min(Number(opt("--workers") ?? Math.max(1, availableParallelism() - 1)), points.length));
const t0 = Date.now();

console.log(`sweep ${sweepId}: ${points.length} configs × mode ${grid.mode}, ${nWorkers} workers, data up to ${new Date(toMs).toISOString()}`);

// 1. run the grid
const chunks: (typeof points)[] = Array.from({ length: nWorkers }, () => []);
points.forEach((p, i) => chunks[i % nWorkers]!.push(p));
const outputs = await Promise.all(
  chunks.map(
    (chunk, w) =>
      new Promise<WorkerOutput>((resolve, reject) => {
        const input: WorkerInput = { dataDir, replay: { toMs }, modes: [grid.mode], configs: chunk.map((p) => ({ id: p.id, cfg: p.cfg })) };
        const worker = new Worker(new URL("./worker.ts", import.meta.url), { workerData: input });
        worker.once("message", (m: WorkerOutput) => {
          console.log(`  worker ${w}: ${chunk.length} configs, ${m.events.toLocaleString()} events, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
          resolve(m);
        });
        worker.once("error", reject);
      }),
  ),
);
const rowsById = new Map<string, MarketResultRow[]>(outputs.flatMap((o) => o.results.map((r) => [r.id, r.rows] as const)));

// 2. exclusions from market health, then the in-sample / out-of-sample split
const inst = await DuckDBInstance.create(":memory:");
const conn = await inst.connect();
const allMarkets = new Map<string, number>();
for (const rows of rowsById.values()) for (const r of rows) allMarkets.set(r.marketId, r.windowStart);
const days = [...new Set([...allMarkets.values()].map((ms) => new Date(ms).toISOString().slice(0, 10)))].sort();
for (const d of days) await writeHealth(conn, dataDir, d, (await computeDayHealth(cfg, d)).markets);
await createViews(conn, dataDir);
const excluded = new Set(
  ((await conn.runAndReadAll("SELECT market_id FROM market_health WHERE excluded")).getRowObjectsJS() as { market_id: string }[]).map((r) => r.market_id),
);
const healthKnown = new Set(((await conn.runAndReadAll("SELECT market_id FROM market_health")).getRowObjectsJS() as { market_id: string }[]).map((r) => r.market_id));
const usable = [...allMarkets].filter(([id]) => healthKnown.has(id) && !excluded.has(id)).sort((a, b) => a[1] - b[1]);

const byDay = days.length >= 5;
let boundaryMs: number;
if (byDay) {
  const isDays = Math.ceil(days.length * cfg.report.inSampleFrac);
  boundaryMs = Date.parse(`${days[Math.min(isDays, days.length - 1)]}T00:00:00Z`);
} else {
  boundaryMs = usable[Math.floor(usable.length * cfg.report.inSampleFrac)]?.[1] ?? toMs;
}
const isIds = new Set(usable.filter(([, ws]) => ws < boundaryMs).map(([id]) => id));
const oosIds = new Set(usable.filter(([, ws]) => ws >= boundaryMs).map(([id]) => id));
console.log(
  `split by ${byDay ? "day" : "market (fewer than 5 days of data)"} at ${new Date(boundaryMs).toISOString()}: ${isIds.size} in-sample, ${oosIds.size} out-of-sample usable markets (${allMarkets.size - usable.length} excluded)`,
);

interface Metrics {
  markets: number;
  volume: number;
  edgeCents: number | null;
  edgeCentsExRebates: number | null;
  meanPnl: number | null;
  tStat: number | null;
}
const metrics = (rows: MarketResultRow[], ids: Set<string>): Metrics => {
  const rs = rows.filter((r) => ids.has(r.marketId) && r.mode === grid.mode);
  const volume = sum(rs.map((r) => r.volumeFilled));
  const net = rs.map((r) => r.pnlTrading + r.rebateEst - r.fees);
  const fin = (x: number) => (Number.isFinite(x) ? x : null);
  return {
    markets: rs.length,
    volume,
    edgeCents: volume ? fin((100 * sum(net)) / volume) : null,
    edgeCentsExRebates: volume ? fin((100 * sum(rs.map((r) => r.pnlTrading - r.fees))) / volume) : null,
    meanPnl: fin(mean(net)),
    tStat: fin(tStat(net)),
  };
};
const configs = points.map((p) => ({ id: p.id, overrides: p.overrides, is: metrics(rowsById.get(p.id) ?? [], isIds), oos: metrics(rowsById.get(p.id) ?? [], oosIds) }));

// selection on in-sample only: primary gate is edge excluding rebates (PLAN.md §12)
const eligible = configs.filter((c) => c.is.volume >= grid.minInSampleVolume && c.is.edgeCentsExRebates !== null);
const chosen = eligible.reduce<(typeof configs)[number] | null>((best, c) => (!best || c.is.edgeCentsExRebates! > best.is.edgeCentsExRebates! ? c : best), null);
if (!chosen) throw new Error("no config traded enough in-sample volume; lower minInSampleVolume or record more data");

// 3. plateau: neighbours one grid step away along the plateau axes, everything else equal
const values = new Map<string, Value[]>(grid.params);
const neighbours = configs.filter((c) => {
  let diffAxis = 0;
  for (const [path] of grid.params) {
    if (c.overrides[path] === chosen.overrides[path]) continue;
    if (!grid.plateauAxes.includes(path)) return false;
    const vs = values.get(path)!;
    if (Math.abs(vs.indexOf(c.overrides[path]!) - vs.indexOf(chosen.overrides[path]!)) !== 1) return false;
    diffAxis++;
  }
  return diffAxis === 1;
});
const ce = chosen.is.edgeCentsExRebates!;
const plateauPass = ce > 0 && neighbours.length > 0 && neighbours.every((n) => n.is.edgeCentsExRebates !== null && Math.abs(n.is.edgeCentsExRebates - ce) <= cfg.report.plateauFrac * Math.abs(ce));
console.log(`chosen ${chosen.id} ${JSON.stringify(chosen.overrides)}: in-sample edge ex rebates ${ce.toFixed(3)}¢/sh; plateau ${plateauPass ? "PASS" : "FAIL"} (${neighbours.length} neighbours)`);

// 4. out-of-sample run of the chosen config, all fill modes. Warm up for 60 min before the boundary
// so the 600 s-half-life vol EWMA and the basis have converged (≈ the state the sweep pass had there).
const oosRunId = `${sweepId}-oos`;
const chosenCfg = points.find((p) => p.id === chosen.id)!.cfg;
if (oosIds.size) {
  await backtest({
    cfg: chosenCfg,
    conn,
    runId: oosRunId,
    strategy: () => new MarketMaker(chosenCfg),
    replay: { fromMs: boundaryMs - 60 * 60_000, toMs },
    keepMarket: (ws) => ws >= boundaryMs,
  });
  writeFileSync(join(runDir(dataDir, oosRunId), "analysis.json"), JSON.stringify(analyzeRun(oosRunId, await loadRun(conn, dataDir, oosRunId), { timeZone: cfg.dashboard.timeZone })));
}
conn.closeSync();
inst.closeSync();

const out = {
  sweepId,
  createdAt: new Date().toISOString(),
  mode: grid.mode as FillMode,
  params: grid.params,
  plateauAxes: grid.plateauAxes,
  dataTo: toMs,
  split: { by: byDay ? "day" : "market", boundaryMs, inSampleMarkets: isIds.size, outOfSampleMarkets: oosIds.size, excludedMarkets: allMarkets.size - usable.length, days },
  configsTried: configs.length,
  configs,
  chosenId: chosen.id,
  chosenOverrides: chosen.overrides,
  plateau: { pass: plateauPass, frac: cfg.report.plateauFrac, neighbours: neighbours.map((n) => ({ id: n.id, overrides: n.overrides, isEdgeExRebates: n.is.edgeCentsExRebates })) },
  oosRunId: oosIds.size ? oosRunId : null,
  wallSec: Math.round((Date.now() - t0) / 1000),
};
const dir = join(dataDir, "sweeps", sweepId);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "sweep.json"), JSON.stringify(out, null, 2));

console.log("\ntop configs by in-sample edge ex rebates (¢/share, " + grid.mode + "):");
console.log("id     " + grid.params.map(([p]) => p.split(".").at(-1)!.padStart(14)).join("") + "   IS edge   IS vol   OOS edge   OOS t");
for (const c of [...eligible].sort((a, b) => b.is.edgeCentsExRebates! - a.is.edgeCentsExRebates!).slice(0, 10)) {
  const f = (x: number | null, d = 3) => (x === null ? "—" : x.toFixed(d));
  console.log(
    `${c.id}${c.id === chosen.id ? "*" : " "}  ` +
      grid.params.map(([p]) => String(c.overrides[p]).padStart(14)).join("") +
      `${f(c.is.edgeCentsExRebates).padStart(10)}${c.is.volume.toFixed(0).padStart(9)}${f(c.oos.edgeCentsExRebates).padStart(11)}${f(c.oos.tStat, 2).padStart(8)}`,
  );
}
console.log(`\nwrote ${join(dir, "sweep.json")}${oosIds.size ? ` and run ${oosRunId}` : ""} in ${out.wallSec}s · next: pnpm report ${sweepId}`);
