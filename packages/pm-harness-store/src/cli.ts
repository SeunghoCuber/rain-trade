// Data tooling. Run from the repo root:
//   node packages/pm-harness-store/src/cli.ts compact [--force] [YYYY-MM-DD ...]
//   node packages/pm-harness-store/src/cli.ts health  [YYYY-MM-DD ...]     (default: yesterday + today)
//   node packages/pm-harness-store/src/cli.ts sql     ["<query>"]          (no query: table overview)
// Options: --config <path> (default config/default.yaml)

import { DuckDBInstance } from "@duckdb/node-api";
import { loadConfig } from "@rain/pm-harness-core";
import { compactAll } from "./compact.ts";
import { computeDayHealth, formatDayHealth } from "./day.ts";
import { openStore, writeHealth } from "./store.ts";
import { TABLE_NAMES } from "./tables.ts";

const args = process.argv.slice(2);
const cmd = args.shift();
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
};
const opt = (name: string) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};

const cfg = loadConfig(opt("--config") ?? "config/default.yaml");
const dataDir = cfg.recorder.dataDir;
const today = () => new Date().toISOString().slice(0, 10);
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

function printRows(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) return console.log("(no rows)");
  const cols = Object.keys(rows[0]!);
  const cell = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "bigint" ? v.toString() : typeof v === "object" ? String(v) : String(v));
  const widths = cols.map((c) => Math.min(60, Math.max(c.length, ...rows.map((r) => cell(r[c]).length))));
  const line = (vals: string[]) => vals.map((v, i) => v.slice(0, widths[i]).padEnd(widths[i]!)).join("  ");
  console.log(line(cols));
  console.log(widths.map((w) => "─".repeat(w)).join("  "));
  for (const r of rows) console.log(line(cols.map((c) => cell(r[c]))));
  console.log(`(${rows.length} rows)`);
}

async function main() {
  switch (cmd) {
    case "compact": {
      const force = flag("--force");
      const inst = await DuckDBInstance.create(":memory:");
      const conn = await inst.connect();
      const reports = await compactAll(conn, dataDir, {
        force,
        ...(args.length ? { dates: args } : {}),
        onHour: (r) =>
          console.log(
            `${r.date} ${String(r.hour).padStart(2, "0")}h  ${r.events.toLocaleString()} events → ${Object.entries(r.rows)
              .map(([t, n]) => `${t}:${n}`)
              .join(" ")}  ${(r.ms / 1000).toFixed(1)}s${r.badLines ? `  ⚠️ ${r.badLines} bad lines (${r.firstBadLine})` : ""}`,
          ),
      });
      console.log(reports.length ? `compacted ${reports.length} hour(s)` : "nothing to compact (current hour is still being written)");
      conn.closeSync();
      inst.closeSync();
      break;
    }
    case "health": {
      const dates = args.length ? args : [yesterday(), today()];
      const inst = await DuckDBInstance.create(":memory:");
      const conn = await inst.connect();
      for (const date of dates) {
        const d = await computeDayHealth(cfg, date);
        console.log(formatDayHealth(d, cfg.market.durationSec));
        const path = await writeHealth(conn, dataDir, date, d.markets);
        console.log(d.markets.length ? `wrote ${path}` : "no markets that day");
      }
      conn.closeSync();
      inst.closeSync();
      break;
    }
    case "sql": {
      const store = await openStore(dataDir);
      const q = args.join(" ").trim();
      if (q) {
        const r = await store.conn.runAndReadAll(q);
        printRows(r.getRowObjectsJS() as Record<string, unknown>[]);
      } else {
        const counts = [];
        for (const t of [...TABLE_NAMES, "market_health", "markets"]) {
          const r = await store.conn.runAndReadAll(`SELECT count(*) AS n FROM ${t}`);
          counts.push({ view: t, rows: r.getRowObjectsJS()[0]!.n });
        }
        printRows(counts);
        console.log('\nexample: pnpm data:sql "SELECT slug, outcome, flags, excluded FROM markets ORDER BY window_start"');
      }
      store.close();
      break;
    }
    default:
      console.error("usage: cli.ts compact|health|sql ...  (see header of packages/pm-harness-store/src/cli.ts)");
      process.exit(2);
  }
}

await main();
