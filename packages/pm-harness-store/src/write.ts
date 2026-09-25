import { mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { ColType } from "./tables.ts";

export type Cell = string | number | bigint | boolean | null;
export type Columns = readonly (readonly [string, ColType])[];

const sqlStr = (s: string) => `'${s.replaceAll("'", "''")}'`;
let seq = 0;

/** Write rows to a Parquet file atomically (temp file + rename). Rows align with `columns`. */
export async function writeParquet(conn: DuckDBConnection, path: string, columns: Columns, rows: Iterable<readonly Cell[]>): Promise<number> {
  const t = `_w${++seq}`;
  await conn.run(`CREATE OR REPLACE TEMP TABLE ${t} (${columns.map(([c, ty]) => `${c} ${ty}`).join(", ")})`);
  const a = await conn.createAppender(t, "main", "temp");
  let n = 0;
  for (const row of rows) {
    for (let i = 0; i < columns.length; i++) {
      const v = row[i] ?? null;
      const ty = columns[i]![1];
      if (v === null || (typeof v === "number" && !Number.isFinite(v))) a.appendNull();
      else if (ty === "VARCHAR") a.appendVarchar(String(v));
      else if (ty === "BIGINT") a.appendBigInt(typeof v === "bigint" ? v : BigInt(Math.round(Number(v))));
      else if (ty === "INTEGER") a.appendInteger(Number(v));
      else if (ty === "SMALLINT") a.appendSmallInt(Number(v));
      else if (ty === "BOOLEAN") a.appendBoolean(Boolean(v));
      else a.appendDouble(Number(v));
    }
    a.endRow();
    n++;
  }
  a.closeSync();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await conn.run(`COPY temp.${t} TO ${sqlStr(tmp)} (FORMAT parquet, COMPRESSION zstd)`);
  await conn.run(`DROP TABLE temp.${t}`);
  renameSync(tmp, path);
  return n;
}
