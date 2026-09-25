// Analytics (Phase 8): `pnpm analyze <runId> [--no-health]` → tables + data/runs/<runId>/analysis.json
// Refreshes market health for the run's days first (exclusions), then computes PLAN.md §7 metrics.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { analyzeRun, loadRun, runDir, type ModeAnalysis } from "@rain/pm-harness-analytics";
import { loadConfig } from "@rain/pm-harness-core";
import { computeDayHealth, writeHealth } from "@rain/pm-harness-store";

const args = process.argv.slice(2);
const runId = args.find((a) => !a.startsWith("--"));
if (!runId) throw new Error("usage: pnpm analyze <runId>");
const cfg = loadConfig(args.includes("--config") ? args[args.indexOf("--config") + 1]! : "config/default.yaml");
const inst = await DuckDBInstance.create(":memory:");
const conn = await inst.connect();

if (!args.includes("--no-health")) {
  const first = await loadRun(conn, cfg.recorder.dataDir, runId);
  const days = [...new Set(first.markets.map((m) => new Date(m.windowStart).toISOString().slice(0, 10)))].sort();
  for (const d of days) await writeHealth(conn, cfg.recorder.dataDir, d, (await computeDayHealth(cfg, d)).markets);
}
const input = await loadRun(conn, cfg.recorder.dataDir, runId);
const a = analyzeRun(runId, input, { timeZone: cfg.dashboard.timeZone });
writeFileSync(join(runDir(cfg.recorder.dataDir, runId), "analysis.json"), JSON.stringify(a));
conn.closeSync();
inst.closeSync();

const f = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? "—" : x.toFixed(d));
const row = (label: string, g: (m: ModeAnalysis) => string) => console.log(label.padEnd(34) + a.modes.map((m) => g(m).padStart(16)).join(""));
console.log(`\nrun ${runId}\n`);
row("", (m) => m.mode);
row("markets used / total (excluded)", (m) => `${m.markets}/${m.marketsTotal} (${m.excludedMarkets})`);
row("fills / volume (shares)", (m) => `${m.fills} / ${m.volume.toFixed(0)}`);
row("net PnL $ (incl. rebates)", (m) => f(m.netPnl));
row("  trading / rebates $", (m) => `${f(m.pnl.trading)} / ${f(m.pnl.rebates)}`);
row("  spread / adverse / inventory $", (m) => `${f(m.pnl.spread, 0)}/${f(m.pnl.adverse, 0)}/${f(m.pnl.inventory, 0)}`);
row("edge ¢/share (ex rebates)", (m) => `${f(m.edgeCents, 3)} (${f(m.edgeCentsExRebates, 3)})`);
row(`95% CI edge ¢/sh (${a.modes[0]!.bootstrap.blockBy} blocks)`, (m) => `[${f(m.bootstrap.edgeCents.lo95, 2)}, ${f(m.bootstrap.edgeCents.hi95, 2)}]`);
row("95% CI edge ex rebates", (m) => `[${f(m.bootstrap.edgeCentsExRebates.lo95, 2)}, ${f(m.bootstrap.edgeCentsExRebates.hi95, 2)}]`);
row("P(edge > 0)", (m) => f(m.bootstrap.edgeCents.pPositive, 3));
row("t-stat (PnL per market)", (m) => f(m.tStat, 2));
row("PnL/market mean / median $", (m) => `${f(m.perMarket.mean)} / ${f(m.perMarket.median)}`);
row("PnL/market sd / skew", (m) => `${f(m.perMarket.sd)} / ${f(m.perMarket.skew)}`);
row("PnL/market p5 / p95 $", (m) => `${f(m.perMarket.p5)} / ${f(m.perMarket.p95)}`);
row("hit rate / win:loss", (m) => `${f(100 * m.hitRate, 0)}% / ${f(m.winLossRatio)}`);
row("Sharpe (daily, annualized)", (m) => f(m.sharpeDaily));
row("max drawdown $ (markets)", (m) => `${f(m.maxDrawdown)} (${m.maxDrawdownMarkets})`);
row("fill rate / quote uptime", (m) => `${f(m.fillRate === null ? null : 100 * m.fillRate, 1)}% / ${f(m.quoteUptimePct, 0)}%`);
row("toxic fills / cancel-latency fills", (m) => `${f(100 * m.toxicFillShare, 0)}% / ${f(100 * m.cancelLatencyFillShare, 0)}%`);
row("mean |inv| before fill / max", (m) => `${f(m.meanAbsInventoryBeforeFill, 0)} / ${f(m.maxAbsInventory, 0)}`);
row("capital used (max) $", (m) => f(m.capitalUsed));

console.log("\nmarkout ¢/share (base) by horizon:");
const base = a.modes.find((m) => m.mode === "base")!;
console.log("  " + base.markouts.map((p) => `${p.horizon}: ${f(p.cents, 2)} [${f(p.lo95, 2)}, ${f(p.hi95, 2)}]`).join("   "));
console.log("\nbreakdowns (base): edge ¢/share at settlement | 5 s markout");
for (const dim of ["minute", "fvBucket", "volTercile", "side", "inventory"]) {
  const bs = base.breakdowns.filter((b) => b.dimension === dim);
  console.log(`  ${dim.padEnd(11)} ` + bs.map((b) => `${b.bucket}: ${f(b.edgeCents, 1)}|${f(b.markout5Cents, 1)} (n=${b.fills})`).join("  "));
}
console.log(`\nwrote ${join(runDir(cfg.recorder.dataDir, runId), "analysis.json")}`);
