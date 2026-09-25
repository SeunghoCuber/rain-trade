// Replay recorded data (Phase 3). From the repo root:
//   pnpm replay [--from 2026-09-25T00:00Z] [--to 2026-09-25T06:00Z] [--market <slug|conditionId>] [--parquet] [--config <path>]
// Reads raw NDJSON by default (~2.3x faster for full sequential replays); --parquet reads the compacted
// tables instead. Both give the identical digest (compaction is lossless).
// Prints event counts, book-reconstruction checks, and a digest; identical digests = identical replays.

import { DuckDBInstance } from "@duckdb/node-api";
import { loadConfig } from "@rain/pm-harness-core";
import { openStore } from "@rain/pm-harness-store";
import { runVerifiedReplay } from "./replay-run.ts";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const cfg = loadConfig(opt("--config") ?? "config/default.yaml");
const dataDir = cfg.recorder.dataDir;
const parseTime = (s: string | undefined) => {
  if (s === undefined) return undefined;
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`bad time ${s}`);
  return t;
};

let marketIds: string[] | undefined;
const market = opt("--market");
if (market) {
  const store = await openStore(dataDir);
  const r = await store.conn.runAndReadAll(`SELECT market_id FROM markets WHERE market_id = $m OR slug = $m`, { m: market });
  marketIds = r.getRowObjectsJS().map((x) => x.market_id as string);
  store.close();
  if (!marketIds.length) throw new Error(`market ${market} not found (is it compacted? try pnpm data:compact)`);
}

const inst = await DuckDBInstance.create(":memory:");
const conn = await inst.connect();
const fromMs = parseTime(opt("--from"));
const toMs = parseTime(opt("--to"));
const s = await runVerifiedReplay(conn, dataDir, {
  ...(fromMs !== undefined ? { fromMs } : {}),
  ...(toMs !== undefined ? { toMs } : {}),
  ...(marketIds ? { marketIds } : {}),
  ...(args.includes("--parquet") ? {} : { rawOnly: true }),
});
conn.closeSync();
inst.closeSync();

const iso = (ms: number | null) => (ms === null ? "—" : new Date(ms).toISOString());
const c = s.checks;
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(3)}%` : "—");
console.log(`replayed ${s.events.toLocaleString()} events  ${iso(s.firstMs)} → ${iso(s.lastMs)}  in ${(s.wallMs / 1000).toFixed(1)}s (${Math.round(s.events / (s.wallMs / 1000)).toLocaleString()} ev/s)`);
console.log(`kinds: ${JSON.stringify(s.kinds)}`);
console.log(`markets: ${s.markets}   out-of-order events: ${s.outOfOrder}`);
console.log(`book vs snapshots:   ${c.snapshotsChecked.toLocaleString()} checked, ${c.snapshotMismatches} with a differing level (${pct(c.snapshotMismatches, c.snapshotsChecked)}): ${c.levelMismatches} levels, ${c.nearTopMismatches} within 5 ticks of best`);
console.log(`book vs reported best bid/ask: ${c.bestChecked.toLocaleString()} checked, ${c.bestMismatches} mismatched (${pct(c.bestMismatches, c.bestChecked)}); levels pruned as consumed: ${c.levelsPruned}`);
console.log(`changes before first snapshot / after a gap: ${c.unsyncedChanges}`);
if (c.firstMismatch) console.log(`first mismatch: ${c.firstMismatch}`);
console.log(`digest: ${s.digest}`);
