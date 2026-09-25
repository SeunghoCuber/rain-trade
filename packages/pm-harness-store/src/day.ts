import type { Config } from "@rain/pm-harness-core";
import { HealthAccumulator, type MarketHealth } from "./health.ts";
import { listRawHours, readRawHour } from "./raw.ts";

const DAY = 86_400_000;
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface DayHealth {
  date: string;
  markets: MarketHealth[];
  expected: number;
  events: number;
  badLines: number;
  kinds: Record<string, number>;
}

/**
 * Health for markets whose window starts on `date` (UTC). Reads the raw files for that day plus the
 * previous day's last hour (the 00:00 market registers ~90 s early) and the next day's first 3 hours
 * (official resolutions arrive ~20 min after close, occasionally later).
 */
export async function computeDayHealth(cfg: Config, date: string, nowMs = Date.now()): Promise<DayHealth> {
  const start = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(start)) throw new Error(`bad date ${date}`);
  const prev = isoDate(start - DAY);
  const next = isoDate(start + DAY);
  const hours = listRawHours(cfg.recorder.dataDir, [prev, date, next]).filter(
    (h) => h.date === date || (h.date === prev && h.hour === 23) || (h.date === next && h.hour < 3),
  );
  const acc = new HealthAccumulator(cfg);
  let badLines = 0;
  for (const h of hours) {
    for await (const r of readRawHour(h.path)) {
      if ("error" in r) badLines++;
      else acc.add(r.ev);
    }
  }
  return {
    date,
    markets: acc.finish(start, start + DAY, nowMs),
    expected: Math.round(DAY / (cfg.market.durationSec * 1000)),
    events: acc.events,
    badLines,
    kinds: acc.kinds,
  };
}

const fmt = (x: number | null | undefined, d = 2) => (x == null ? "—" : x.toFixed(d));
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

/** Human-readable table, one row per market. */
export function formatDayHealth(d: DayHealth, windowSec: number): string {
  const out: string[] = [];
  out.push(`\n${d.date}: ${d.events.toLocaleString()} events read${d.badLines ? `, ${d.badLines} bad lines` : ""}  ${JSON.stringify(d.kinds)}\n`);
  out.push("window  deltas  trades  snaps  late(s)  clobHole  recHole  feedGap  clTicks  outcome  ours  ourS0−ptb     ourS1−final   excl  flags");
  const flagCounts: Record<string, number> = {};
  for (const m of d.markets) {
    for (const f of m.flags) flagCounts[f] = (flagCounts[f] ?? 0) + 1;
    out.push(
      [
        hhmm(m.windowStart).padEnd(6),
        String(m.deltas).padStart(7),
        String(m.trades).padStart(7),
        String(m.snapshots).padStart(6),
        fmt(m.lateSec, 1).padStart(8),
        String(m.clobHoleMs).padStart(9),
        String(m.recHoleMs).padStart(8),
        String(m.feedGapMs).padStart(8),
        `${m.clTicks}/${windowSec}`.padStart(8),
        (m.outcome ?? "—").padStart(8),
        (m.ourOutcome ?? "—").padStart(5),
        fmt(m.s0Diff, 9).padStart(12),
        fmt(m.s1Diff, 9).padStart(14),
        (m.excluded ? "yes" : "").padStart(6),
        "  " + m.flags.join(","),
      ].join(" "),
    );
  }
  const closed = d.markets.filter((m) => !m.flags.includes("OPEN"));
  const usable = closed.filter((m) => !m.excluded);
  out.push(
    `\nmarkets: ${d.markets.length}/${d.expected} recorded, ${closed.length} closed, ${usable.length} usable (not excluded)   flags: ${JSON.stringify(flagCounts)}`,
  );
  return out.join("\n");
}
