// Backtest (Phase 6): `pnpm backtest [--from ISO] [--to ISO] [--run-id id] [--strategy mm|none] [--config path]`
// Runs the strategy through the fill simulator in all three fill modes and writes
// data/runs/<runId>/{fills,markets,fv,quotes}.parquet + run.json.

import { DuckDBInstance } from "@duckdb/node-api";
import { loadConfig } from "@rain/pm-harness-core";
import { MarketMaker, NoQuote } from "@rain/pm-harness-strategy";
import { backtest } from "./backtest-lib.ts";

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const cfg = loadConfig(opt("--config") ?? "config/default.yaml");
const strategyName = opt("--strategy") ?? "mm";
const runId = opt("--run-id") ?? `${strategyName}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}`;
const fromMs = opt("--from") ? Date.parse(opt("--from")!) : undefined;
const toMs = opt("--to") ? Date.parse(opt("--to")!) : undefined;

const inst = await DuckDBInstance.create(":memory:");
const conn = await inst.connect();
const out = await backtest({
  cfg,
  conn,
  runId,
  strategy: () => (strategyName === "none" ? new NoQuote() : new MarketMaker(cfg)),
  replay: { ...(fromMs !== undefined ? { fromMs } : {}), ...(toMs !== undefined ? { toMs } : {}) },
});
conn.closeSync();
inst.closeSync();

const r = out.runner;
console.log(`run ${runId}: ${r.events.toLocaleString()} events in ${(out.wallMs / 1000).toFixed(1)}s → ${out.dir}`);
console.log(`markets settled: ${new Set(r.results.map((x) => x.marketId)).size}   digest ${out.digest.slice(0, 16)}\n`);
console.log("mode          markets  fills   volume    trading$   spread$  adverse$  invent$   rebate$   edge¢/sh  uptime%  cxl-lat fills");
for (const m of r.modes) {
  const rs = r.results.filter((x) => x.mode === m.mode);
  const sum = (f: (x: (typeof rs)[number]) => number) => rs.reduce((a, x) => a + f(x), 0);
  const vol = sum((x) => x.volumeFilled);
  const net = sum((x) => x.pnlTrading + x.rebateEst - x.fees);
  console.log(
    [
      m.mode.padEnd(12),
      String(rs.length).padStart(8),
      String(sum((x) => x.fills)).padStart(6),
      vol.toFixed(0).padStart(9),
      sum((x) => x.pnlTrading).toFixed(2).padStart(11),
      sum((x) => x.pnlSpread).toFixed(2).padStart(9),
      sum((x) => x.pnlAdverse).toFixed(2).padStart(9),
      sum((x) => x.pnlInventory).toFixed(2).padStart(9),
      sum((x) => x.rebateEst).toFixed(2).padStart(9),
      (vol ? (100 * net) / vol : 0).toFixed(3).padStart(10),
      (rs.length ? sum((x) => x.quoteUptimePct) / rs.length : 0).toFixed(1).padStart(8),
      String(sum((x) => x.cancelLatencyFills)).padStart(9),
    ].join(" "),
  );
}
const maxErr = Math.max(0, ...r.results.map((x) => x.decompError));
console.log(`\ndecomposition identity: max |trading − (spread + adverse + inventory)| = ${maxErr.toExponential(2)}`);
