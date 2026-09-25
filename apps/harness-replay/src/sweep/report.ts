// Go / No-Go report (PLAN.md §10): `pnpm report <sweepId>`
// Every criterion is evaluated on the OUT-OF-SAMPLE run of the config the sweep chose on in-sample
// data, in pessimistic fill mode. Writes data/sweeps/<id>/report.{json,md} and exits 0 (GO) / 2 (NO-GO).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { mean, quantile, runDir, type ModeAnalysis, type RunAnalysis } from "@rain/pm-harness-analytics";
import { loadConfig } from "@rain/pm-harness-core";

const args = process.argv.slice(2);
const sweepId = args.find((a) => !a.startsWith("--"));
if (!sweepId) throw new Error("usage: pnpm report <sweepId>");
const cfg = loadConfig(args.includes("--config") ? args[args.indexOf("--config") + 1]! : "config/default.yaml");
const dataDir = cfg.recorder.dataDir;
const dir = join(dataDir, "sweeps", sweepId);
const sweep = JSON.parse(readFileSync(join(dir, "sweep.json"), "utf8")) as {
  sweepId: string;
  mode: string;
  configsTried: number;
  chosenId: string;
  chosenOverrides: Record<string, unknown>;
  split: { by: string; boundaryMs: number; inSampleMarkets: number; outOfSampleMarkets: number; days: string[] };
  plateau: { pass: boolean; frac: number; neighbours: { id: string; isEdgeExRebates: number | null }[] };
  configs: { id: string; is: { edgeCentsExRebates: number | null } }[];
  oosRunId: string | null;
};
const r = cfg.report;

interface Criterion {
  name: string;
  threshold: string;
  value: string;
  pass: boolean;
}
const criteria: Criterion[] = [];
const f = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? "—" : x.toFixed(d));

let a: ModeAnalysis | null = null;
let brier: { fv: number; mid: number; n: number } | null = null;
let terciles: { name: string; markets: number; meanPnl: number }[] = [];
let oosDays = 0;
if (sweep.oosRunId && existsSync(join(runDir(dataDir, sweep.oosRunId), "analysis.json"))) {
  const run = JSON.parse(readFileSync(join(runDir(dataDir, sweep.oosRunId), "analysis.json"), "utf8")) as RunAnalysis;
  a = run.modes.find((m) => m.mode === "pessimistic") ?? null;
  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();
  const p = (x: string) => `'${join(runDir(dataDir, sweep.oosRunId!), x).replaceAll("'", "''")}'`;
  // FV calibration on OOS markets: FV and Polymarket mid vs the official outcome, 1 s samples
  const [b] = (
    await conn.runAndReadAll(`
      WITH o AS (SELECT DISTINCT market_id, outcome FROM read_parquet(${p("markets.parquet")})),
      s AS (SELECT f.*, o.outcome FROM read_parquet(${p("fv.parquet")}) f JOIN o USING (market_id) WHERE f.ts % 1000 < 250 AND f.mid IS NOT NULL)
      SELECT avg((fv - outcome)^2) AS fv, avg((mid - outcome)^2) AS mid, count(*) AS n FROM s`)
  ).getRowObjectsJS() as { fv: number; mid: number; n: bigint }[];
  if (b && Number(b.n) > 0) brier = { fv: b.fv, mid: b.mid, n: Number(b.n) };
  // vol terciles on usable OOS markets (the analysis's cumulative list is exactly those)
  const usable = new Set(a?.cumulative.map((c) => c.slug) ?? []);
  const rows = (await conn.runAndReadAll(`SELECT slug, realized_vol, pnl_trading + rebate_est - fees AS pnl FROM read_parquet(${p("markets.parquet")}) WHERE mode = 'pessimistic'`)).getRowObjectsJS() as { slug: string; realized_vol: number; pnl: number }[];
  const us = rows.filter((x) => usable.has(x.slug) && Number.isFinite(x.realized_vol));
  const vols = us.map((x) => x.realized_vol);
  const t1 = quantile(vols, 1 / 3), t2 = quantile(vols, 2 / 3);
  terciles = [
    ["low", (v: number) => v <= t1],
    ["med", (v: number) => v > t1 && v <= t2],
    ["high", (v: number) => v > t2],
  ].map(([name, inT]) => {
    const xs = us.filter((x) => (inT as (v: number) => boolean)(x.realized_vol));
    return { name: name as string, markets: xs.length, meanPnl: mean(xs.map((x) => x.pnl)) };
  });
  if (a?.cumulative.length) oosDays = (a.cumulative[a.cumulative.length - 1]!.windowStart - a.cumulative[0]!.windowStart) / 86_400_000;
  conn.closeSync();
  inst.closeSync();
}

criteria.push({
  name: "Sample size",
  threshold: `≥ ${r.minMarkets} non-excluded OOS markets, ≥ ${r.minDays} days`,
  value: a ? `${a.markets} markets over ${f(oosDays, 1)} days` : "no OOS run",
  pass: !!a && a.markets >= r.minMarkets && oosDays >= r.minDays,
});
criteria.push({
  name: "Net edge (excl. rebates)",
  threshold: "95% CI lower bound ≥ 0",
  value: a ? `${f(a.edgeCentsExRebates, 3)}¢/sh, CI [${f(a.bootstrap.edgeCentsExRebates.lo95)}, ${f(a.bootstrap.edgeCentsExRebates.hi95)}]` : "—",
  pass: !!a && a.bootstrap.edgeCentsExRebates.lo95 >= 0,
});
criteria.push({
  name: "Net edge (incl. rebates)",
  threshold: `95% CI lower bound > 0, t-stat ≥ ${r.minTStat}`,
  value: a ? `${f(a.edgeCents, 3)}¢/sh, CI [${f(a.bootstrap.edgeCents.lo95)}, ${f(a.bootstrap.edgeCents.hi95)}], t = ${f(a.tStat)}` : "—",
  pass: !!a && a.bootstrap.edgeCents.lo95 > 0 && (a.tStat ?? -Infinity) >= r.minTStat,
});
criteria.push({
  name: "Regime robustness",
  threshold: "mean PnL/market ≥ 0 in each vol tercile",
  value: terciles.length ? terciles.map((t) => `${t.name} ${f(t.meanPnl)} (n=${t.markets})`).join(", ") : "—",
  pass: terciles.length === 3 && terciles.every((t) => t.markets > 0 && t.meanPnl >= 0),
});
criteria.push({
  name: "Drawdown",
  threshold: `max DD < ${100 * r.maxDrawdownFrac}% of $${r.bankrollUsd} bankroll ($${r.maxDrawdownFrac * r.bankrollUsd})`,
  value: a ? `$${f(Math.abs(a.maxDrawdown))}` : "—",
  pass: !!a && Math.abs(a.maxDrawdown) < r.maxDrawdownFrac * r.bankrollUsd,
});
criteria.push({
  name: "Parameter robustness",
  threshold: `chosen config on a plateau: grid neighbours within ${100 * sweep.plateau.frac}% of its IS edge`,
  value: `${sweep.plateau.neighbours.length} neighbours: ${sweep.plateau.neighbours.map((n) => `${n.id} ${f(n.isEdgeExRebates, 3)}`).join(", ")} vs chosen ${f(sweep.configs.find((c) => c.id === sweep.chosenId)?.is.edgeCentsExRebates, 3)}`,
  pass: sweep.plateau.pass,
});
criteria.push({
  name: "FV calibration",
  threshold: `Brier(FV) ≤ Brier(mid) × ${1 + r.brierTolerance}`,
  value: brier ? `FV ${f(brier.fv, 4)} vs mid ${f(brier.mid, 4)} (${brier.n.toLocaleString()} samples)` : "—",
  pass: !!brier && brier.fv <= brier.mid * (1 + r.brierTolerance),
});

const go = criteria.every((c) => c.pass);
const report = {
  sweepId,
  createdAt: new Date().toISOString(),
  verdict: go ? "GO" : "NO-GO",
  chosen: { id: sweep.chosenId, overrides: sweep.chosenOverrides },
  configsTried: sweep.configsTried,
  split: sweep.split,
  oosRunId: sweep.oosRunId,
  criteria,
};
writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
const md = [
  `# Go / No-Go: ${go ? "GO" : "NO-GO"}`,
  "",
  `Sweep \`${sweepId}\`: ${sweep.configsTried} configs tried; chosen on in-sample data only: \`${sweep.chosenId}\` ${JSON.stringify(sweep.chosenOverrides)}.`,
  `Split by ${sweep.split.by} at ${new Date(sweep.split.boundaryMs).toISOString()}: ${sweep.split.inSampleMarkets} in-sample / ${sweep.split.outOfSampleMarkets} out-of-sample usable markets.`,
  `All criteria below are **out-of-sample, pessimistic fills** (run \`${sweep.oosRunId ?? "—"}\`).`,
  "",
  "| Criterion | Threshold | Value | Result |",
  "|---|---|---|---|",
  ...criteria.map((c) => `| ${c.name} | ${c.threshold} | ${c.value} | ${c.pass ? "PASS" : "**FAIL**"} |`),
  "",
  go
    ? "All criteria hold. Next (PLAN.md §10): go live at ~5–10% of simulated size and run the sim-to-real comparison for 2 weeks before scaling."
    : "At least one criterion fails: do not trade real money on this configuration.",
].join("\n");
writeFileSync(join(dir, "report.md"), md + "\n");
console.log(md);
process.exit(go ? 0 : 2);
