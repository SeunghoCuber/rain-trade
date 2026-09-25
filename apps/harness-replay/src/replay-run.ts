import { createHash } from "node:crypto";
import type { DuckDBConnection } from "@duckdb/node-api";
import { canonicalEvent, MarketStates, ReplayClock, runReplay, type BookCheckStats, type MarketEvent } from "@rain/pm-harness-core";
import { replay, type ReplayOptions } from "@rain/pm-harness-store";

export interface ReplaySummary {
  events: number;
  kinds: Record<string, number>;
  firstMs: number | null;
  lastMs: number | null;
  outOfOrder: number;
  markets: number;
  checks: BookCheckStats;
  /** sha256 over every replayed event (canonicalEvent) and every final book: equal digests = identical replays */
  digest: string;
  wallMs: number;
}

/** Replay recorded data through the event clock and market state, verifying the book as we go. */
export async function runVerifiedReplay(conn: DuckDBConnection, dataDir: string, opts: ReplayOptions = {}): Promise<ReplaySummary> {
  const t0 = Date.now();
  const hash = createHash("sha256");
  const states = new MarketStates({ verify: true });
  const kinds: Record<string, number> = {};
  const clock = new ReplayClock();
  const stats = await runReplay(replay(conn, dataDir, opts), clock, (ev: MarketEvent) => {
    kinds[ev.kind] = (kinds[ev.kind] ?? 0) + 1;
    hash.update(canonicalEvent(ev));
    hash.update("\n");
    states.apply(ev);
  });
  for (const [id, s] of [...states.markets].sort((a, b) => (a[0] < b[0] ? -1 : 1))) hash.update(`${id}=${s.book.digest()}\n`);
  return {
    events: stats.events,
    kinds,
    firstMs: stats.firstNs === null ? null : Number(stats.firstNs / 1_000_000n),
    lastMs: stats.lastNs === null ? null : Number(stats.lastNs / 1_000_000n),
    outOfOrder: stats.outOfOrder,
    markets: states.markets.size,
    checks: states.checks,
    digest: hash.digest("hex"),
    wallMs: Date.now() - t0,
  };
}
