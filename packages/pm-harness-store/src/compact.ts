import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DuckDBAppender, DuckDBConnection } from "@duckdb/node-api";
import { listRawHours, readRawHour, type RawHour } from "./raw.ts";
import { allColumns, rowsFor, TABLE_NAMES, TABLES, type ColType, type TableName, type Value } from "./tables.ts";

export const parquetPath = (dataDir: string, table: string, date: string, hour: number) =>
  join(dataDir, "parquet", table, `date=${date}`, `${String(hour).padStart(2, "0")}.parquet`);

const markerPath = (dataDir: string, date: string, hour: number) =>
  join(dataDir, "parquet", "_done", date, `${String(hour).padStart(2, "0")}.json`);

export interface HourReport {
  date: string;
  hour: number;
  lines: number;
  events: number;
  badLines: number;
  firstBadLine: string | null;
  rows: Partial<Record<TableName, number>>;
  ms: number;
}

const sqlStr = (s: string) => `'${s.replaceAll("'", "''")}'`;

function append(a: DuckDBAppender, type: ColType, v: Value): void {
  if (v === null) return a.appendNull();
  switch (type) {
    case "VARCHAR":
      return a.appendVarchar(String(v));
    case "DOUBLE":
      return a.appendDouble(Number(v));
    case "BIGINT":
      return a.appendBigInt(typeof v === "bigint" ? v : BigInt(Math.round(Number(v))));
    case "INTEGER":
      return a.appendInteger(Number(v));
    case "SMALLINT":
      return a.appendSmallInt(Number(v));
    case "BOOLEAN":
      return a.appendBoolean(Boolean(v));
  }
}

/**
 * Compact one closed raw hour into per-table Parquet files. All files are written to a temp dir
 * first and moved into place, then a marker is written, so a crash at any point leaves either the
 * old state or a complete hour.
 */
export async function compactHour(conn: DuckDBConnection, dataDir: string, h: RawHour): Promise<HourReport> {
  const t0 = Date.now();
  const report: HourReport = { date: h.date, hour: h.hour, lines: 0, events: 0, badLines: 0, firstBadLine: null, rows: {}, ms: 0 };

  const appenders = new Map<TableName, DuckDBAppender>();
  for (const name of TABLE_NAMES) {
    const cols = allColumns(TABLES[name]).map(([c, t]) => `${c} ${t}`).join(", ");
    await conn.run(`CREATE OR REPLACE TABLE ${name} (${cols})`);
    appenders.set(name, await conn.createAppender(name));
  }

  for await (const r of readRawHour(h.path)) {
    report.lines = r.line;
    if ("error" in r) {
      report.badLines++;
      report.firstBadLine ??= `line ${r.line}: ${r.error}`;
      continue;
    }
    report.events++;
    const common: Value[] = [h.hour, r.line, r.ev.recvTs, r.ev.exchangeTs];
    for (const [name, values] of rowsFor(r.ev)) {
      const a = appenders.get(name)!;
      const types = allColumns(TABLES[name]).map(([, t]) => t);
      const all = [...common, ...values];
      for (let i = 0; i < types.length; i++) append(a, types[i]!, all[i]!);
      a.endRow();
      report.rows[name] = (report.rows[name] ?? 0) + 1;
    }
  }
  for (const a of appenders.values()) a.closeSync();

  const tmp = join(dataDir, "parquet", "_tmp", `${h.date}-${h.hour}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const written: [string, string][] = [];
  for (const name of TABLE_NAMES) {
    const dest = parquetPath(dataDir, name, h.date, h.hour);
    if (!report.rows[name]) {
      rmSync(dest, { force: true }); // a re-run must not leave a stale file behind
      continue;
    }
    const file = join(tmp, `${name}.parquet`);
    // rows were appended in file order (recv_ts is monotonic within a recorder run), so no sort is needed
    await conn.run(`COPY ${name} TO ${sqlStr(file)} (FORMAT parquet, COMPRESSION zstd)`);
    written.push([file, dest]);
  }
  for (const name of TABLE_NAMES) await conn.run(`DROP TABLE IF EXISTS ${name}`);
  for (const [file, dest] of written) {
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(file, dest);
  }
  rmSync(tmp, { recursive: true, force: true });

  report.ms = Date.now() - t0;
  const marker = markerPath(dataDir, h.date, h.hour);
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, JSON.stringify({ ...report, source: h.path, compactedAt: new Date().toISOString() }, null, 2));
  return report;
}

export function isCompacted(dataDir: string, date: string, hour: number): boolean {
  return existsSync(markerPath(dataDir, date, hour));
}

export function readMarker(dataDir: string, date: string, hour: number): HourReport | null {
  const p = markerPath(dataDir, date, hour);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as HourReport) : null;
}

/** Compact every closed raw hour that has not been compacted yet (or all, with force). */
export async function compactAll(
  conn: DuckDBConnection,
  dataDir: string,
  opts: { force?: boolean; dates?: readonly string[]; onHour?: (r: HourReport) => void } = {},
): Promise<HourReport[]> {
  const out: HourReport[] = [];
  for (const h of listRawHours(dataDir, opts.dates)) {
    if (!h.closed || (!opts.force && isCompacted(dataDir, h.date, h.hour))) continue;
    const r = await compactHour(conn, dataDir, h);
    opts.onHour?.(r);
    out.push(r);
  }
  return out;
}
