import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { canonicalEvent, type MarketEvent } from "@rain/pm-harness-core";
import { afterAll, describe, expect, it } from "vitest";
import { compactAll } from "./compact.ts";
import { marketEvents, MID, W0, writeRaw } from "./fixtures.ts";
import { replay } from "./replay.ts";

const inst = await DuckDBInstance.create(":memory:");
const conn = await inst.connect();
afterAll(() => {
  conn.closeSync();
  inst.closeSync();
});

const at = (ms: number) => BigInt(ms) * 1_000_000n;
/** every event kind, including a multi-change delta, snapshots (one empty), and several events per recvTs */
function richEvents(): MarketEvent[] {
  const evs = marketEvents({ windowStart: W0 - 1_800_000 });
  const t = W0 - 1_700_000;
  evs.push(
    { kind: "book_snapshot", marketId: MID, token: "UP", exchangeTs: t, recvTs: at(t), payload: { bids: [{ price: 0.3, size: 5 }, { price: 0.29, size: 7 }], asks: [{ price: 0.32, size: 1 }], hash: "h1" } },
    { kind: "book_snapshot", marketId: MID, token: "DOWN", exchangeTs: t, recvTs: at(t), payload: { bids: [], asks: [], hash: "h2" } },
    { kind: "book_delta", marketId: MID, exchangeTs: t, recvTs: at(t), payload: { changes: [
      { token: "UP", side: "BUY", price: 0.31, size: 3, bestBid: 0.31, bestAsk: 0.32 },
      { token: "DOWN", side: "BUY", price: 0.2, size: 0, bestBid: null, bestAsk: 0.7 },
      { token: "UP", side: "SELL", price: 0.99, size: 1.5, bestBid: 0.31, bestAsk: 0.32 },
    ] } },
    { kind: "trade", marketId: MID, token: "DOWN", exchangeTs: t + 1, recvTs: at(t + 1), payload: { price: 0.69, size: 109.375, side: "BUY", feeRateBps: 0, txHash: "0xabc" } },
    { kind: "spot", exchangeTs: t + 1, recvTs: at(t + 1), payload: { type: "trade", source: "coinbase", price: 84000.5, size: 0.01, side: "SELL" } },
    { kind: "res_price", exchangeTs: t + 2, recvTs: at(t + 2), payload: { source: "chainlink", symbol: "btc/usd", price: 84000.1, backfill: true } },
    { kind: "feed_gap", marketId: MID, exchangeTs: t + 3, recvTs: at(t + 3), payload: { feed: "clob:x", gapMs: 1200, reason: "reconnect" } },
    { kind: "feed_gap", exchangeTs: t + 3, recvTs: at(t + 3), payload: { feed: "rtds:chainlink", gapMs: 1000, reason: "sequence_break" } },
    { kind: "tick_size_change", marketId: MID, token: "UP", exchangeTs: t + 4, recvTs: at(t + 4), payload: { oldTickSize: 0.01, newTickSize: 0.001 } },
    { kind: "venue_raw", marketId: MID, exchangeTs: t + 5, recvTs: at(t + 5), payload: { feed: "clob", eventType: "new_thing", data: '{"x":1}' } },
    { kind: "book_delta", marketId: "other", exchangeTs: t + 6, recvTs: at(t + 6), payload: { changes: [{ token: "UP", side: "BUY", price: 0.5, size: 1, bestBid: 0.5, bestAsk: null }] } },
  );
  // stable sort keeps same-recvTs events in insertion order, like the recorder writes them
  return evs.sort((a, b) => (a.recvTs < b.recvTs ? -1 : a.recvTs > b.recvTs ? 1 : 0));
}

async function collect(it: AsyncIterable<MarketEvent>): Promise<string[]> {
  const out: string[] = [];
  for await (const e of it) out.push(canonicalEvent(e));
  return out;
}

describe("replay", () => {
  const evs = richEvents();
  const expected = evs.map(canonicalEvent);

  it("reproduces the recorded stream byte-for-byte from raw NDJSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "raintrade-replay-raw-"));
    writeRaw(dir, evs);
    expect(await collect(replay(conn, dir))).toEqual(expected);
  });

  it("reproduces the same stream from Parquet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "raintrade-replay-pq-"));
    writeRaw(dir, evs);
    await compactAll(conn, dir);
    expect(await collect(replay(conn, dir, { includeRaw: false }))).toEqual(expected);
  });

  it("filters by time range and market, always keeping market-less events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "raintrade-replay-f-"));
    writeRaw(dir, evs);
    await compactAll(conn, dir);
    const fromMs = W0 - 1_700_000;
    const toMs = fromMs + 4;
    const got = await collect(replay(conn, dir, { fromMs, toMs, marketIds: [MID] }));
    const want = evs
      .filter((e) => e.recvTs >= at(fromMs) && e.recvTs < at(toMs) && (!e.marketId || e.marketId === MID))
      .map(canonicalEvent);
    expect(got).toEqual(want);
    expect(got.some((l) => l.includes('"other"'))).toBe(false);
  });
});
