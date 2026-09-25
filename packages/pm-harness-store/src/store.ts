import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import type { MarketHealth } from "./health.ts";
import { allColumns, TABLE_NAMES, TABLES, type ColType } from "./tables.ts";

const sqlStr = (s: string) => `'${s.replaceAll("'", "''")}'`;

export const HEALTH_COLUMNS: [string, ColType, (h: MarketHealth) => string | number | boolean | null][] = [
  ["market_id", "VARCHAR", (h) => h.marketId],
  ["slug", "VARCHAR", (h) => h.slug],
  ["window_start", "BIGINT", (h) => h.windowStart],
  ["window_end", "BIGINT", (h) => h.windowEnd],
  ["deltas", "INTEGER", (h) => h.deltas],
  ["trades", "INTEGER", (h) => h.trades],
  ["snapshots", "INTEGER", (h) => h.snapshots],
  ["late_sec", "DOUBLE", (h) => h.lateSec],
  ["clob_hole_ms", "DOUBLE", (h) => h.clobHoleMs],
  ["rec_hole_ms", "DOUBLE", (h) => h.recHoleMs],
  ["feed_gap_ms", "DOUBLE", (h) => h.feedGapMs],
  ["cl_ticks", "INTEGER", (h) => h.clTicks],
  ["s0", "DOUBLE", (h) => h.s0],
  ["s0_ticks", "INTEGER", (h) => h.s0Ticks],
  ["s1", "DOUBLE", (h) => h.s1],
  ["s1_ticks", "INTEGER", (h) => h.s1Ticks],
  ["our_outcome", "VARCHAR", (h) => h.ourOutcome],
  ["outcome", "VARCHAR", (h) => h.outcome],
  ["price_to_beat", "DOUBLE", (h) => h.priceToBeat],
  ["final_price", "DOUBLE", (h) => h.finalPrice],
  ["s0_diff", "DOUBLE", (h) => h.s0Diff],
  ["s1_diff", "DOUBLE", (h) => h.s1Diff],
  /** comma-separated HealthFlag list ("" = clean) */
  ["flags", "VARCHAR", (h) => h.flags.join(",")],
  ["excluded", "BOOLEAN", (h) => h.excluded],
];

export const healthPath = (dataDir: string, date: string) => join(dataDir, "health", `date=${date}`, "market_health.parquet");

function hasParquet(dir: string): boolean {
  if (!existsSync(dir)) return false;
  return readdirSync(dir, { recursive: true }).some((f) => String(f).endsWith(".parquet"));
}

/** A typed, empty relation, so views exist (and queries type-check) before any data is compacted. */
function emptySelect(cols: readonly (readonly [string, ColType])[]): string {
  return `SELECT ${[...cols.map(([c, t]) => `CAST(NULL AS ${t}) AS ${c}`), "CAST(NULL AS DATE) AS date"].join(", ")} WHERE false`;
}

/**
 * Register one view per table over `<dataDir>/parquet/<table>/date=*\/*.parquet`, plus
 * `market_health` and a joined `markets` view (one row per market: metadata, official outcome, health).
 */
export async function createViews(conn: DuckDBConnection, dataDir: string): Promise<void> {
  const root = resolve(dataDir);
  for (const name of TABLE_NAMES) {
    const dir = join(root, "parquet", name);
    const src = hasParquet(dir)
      ? `SELECT * FROM read_parquet(${sqlStr(join(dir, "*", "*.parquet"))}, hive_partitioning = true, union_by_name = true)`
      : emptySelect(allColumns(TABLES[name]));
    await conn.run(`CREATE OR REPLACE VIEW ${name} AS ${src}`);
  }
  const hdir = join(root, "health");
  await conn.run(
    `CREATE OR REPLACE VIEW market_health AS ${
      hasParquet(hdir)
        ? `SELECT * FROM read_parquet(${sqlStr(join(hdir, "*", "*.parquet"))}, hive_partitioning = true, union_by_name = true)`
        : emptySelect(HEALTH_COLUMNS.map(([c, t]) => [c, t] as const))
    }`,
  );
  await conn.run(`
    CREATE OR REPLACE VIEW markets AS
    WITH o AS (
      SELECT * FROM market_opens QUALIFY row_number() OVER (PARTITION BY market_id ORDER BY recv_ts) = 1
    ), r AS (
      SELECT * FROM resolutions QUALIFY row_number() OVER (PARTITION BY market_id ORDER BY recv_ts DESC) = 1
    )
    SELECT
      o.market_id, o.slug,
      make_timestamp(o.window_start * 1000) AS window_start_utc,
      o.window_start, o.window_end, o.tick_size, o.min_order_size,
      o.fee_rate, o.fee_exponent, o.fee_rebate_rate,
      r.outcome, r.price_to_beat, r.final_price,
      h.flags, coalesce(h.excluded, true) AS excluded,
      h.late_sec, h.clob_hole_ms, h.rec_hole_ms, h.feed_gap_ms, h.cl_ticks,
      h.deltas, h.trades, h.snapshots, h.our_outcome, h.s0_diff, h.s1_diff
    FROM o
    LEFT JOIN r ON r.market_id = o.market_id
    LEFT JOIN market_health h ON h.market_id = o.market_id
  `);
}

export interface Store {
  conn: DuckDBConnection;
  close(): void;
}

/** In-memory DuckDB with views over the data directory. Nothing is copied; queries read Parquet directly. */
export async function openStore(dataDir: string): Promise<Store> {
  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();
  await createViews(conn, dataDir);
  return {
    conn,
    close: () => {
      conn.closeSync();
      inst.closeSync();
    },
  };
}

/** Write one day's market health as Parquet (atomically replaces an earlier run for that day). */
export async function writeHealth(conn: DuckDBConnection, dataDir: string, date: string, rows: MarketHealth[]): Promise<string> {
  const dest = healthPath(dataDir, date);
  if (rows.length === 0) {
    rmSync(dest, { force: true });
    return dest;
  }
  await conn.run(`CREATE OR REPLACE TEMP TABLE _health (${HEALTH_COLUMNS.map(([c, t]) => `${c} ${t}`).join(", ")})`);
  const a = await conn.createAppender("_health", "main", "temp");
  for (const h of rows) {
    for (const [, t, get] of HEALTH_COLUMNS) {
      const v = get(h);
      if (v === null) a.appendNull();
      else if (t === "VARCHAR") a.appendVarchar(String(v));
      else if (t === "BIGINT") a.appendBigInt(BigInt(v as number));
      else if (t === "INTEGER") a.appendInteger(v as number);
      else if (t === "BOOLEAN") a.appendBoolean(v as boolean);
      else a.appendDouble(v as number);
    }
    a.endRow();
  }
  a.closeSync();
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  await conn.run(`COPY (SELECT * FROM temp._health ORDER BY window_start) TO ${sqlStr(tmp)} (FORMAT parquet, COMPRESSION zstd)`);
  await conn.run("DROP TABLE temp._health");
  renameSync(tmp, dest);
  return dest;
}
