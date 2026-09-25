import { createReadStream, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { decodeEvent, type MarketEvent } from "@rain/pm-harness-core";

export interface RawHour {
  /** YYYY-MM-DD (UTC) */
  date: string;
  hour: number;
  path: string;
  /** gzipped = the recorder rotated past it, so it will not grow any more */
  closed: boolean;
}

/** Raw hour files written by the recorder, oldest first. A closed hour appears once (as .gz). */
export function listRawHours(dataDir: string, dates?: readonly string[]): RawHour[] {
  const root = join(dataDir, "raw");
  if (!existsSync(root)) return [];
  const out: RawHour[] = [];
  for (const date of readdirSync(root).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || (dates && !dates.includes(date))) continue;
    const files = readdirSync(join(root, date));
    for (const f of files.sort()) {
      const m = /^(\d{2})\.ndjson(\.gz)?$/.exec(f);
      if (!m) continue;
      const closed = m[2] === ".gz";
      // mid-compression both exist; the plain file is the complete one until the .gz is renamed in
      if (!closed && files.includes(`${f}.gz`)) continue;
      out.push({ date, hour: Number(m[1]), path: join(root, date, f), closed });
    }
  }
  return out;
}

export type RawLine = { line: number; ev: MarketEvent } | { line: number; error: string; text: string };

/** Decode and validate every line. Bad lines (e.g. truncated by a crash) are yielded as errors, not thrown. */
export async function* readRawHour(path: string): AsyncGenerator<RawLine> {
  const input = path.endsWith(".gz") ? createReadStream(path).pipe(createGunzip()) : createReadStream(path);
  let line = 0;
  for await (const text of createInterface({ input, crlfDelay: Infinity })) {
    line++;
    if (!text) continue;
    try {
      yield { line, ev: decodeEvent(text) };
    } catch (err) {
      yield { line, error: (err as Error).message.split("\n")[0]!, text: text.slice(0, 200) };
    }
  }
}

export const recvMs = (ev: MarketEvent) => Number(ev.recvTs / 1_000_000n);
