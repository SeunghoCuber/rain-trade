import { MarketEvent } from "@rain/pm-harness-core";
import { describe, expect, it } from "vitest";
import type { GammaEvent } from "../gamma.ts";
import { normalizeClob, type ClobContext } from "../normalize/clob.ts";
import { normalizeBinance, normalizeCoinbase, normalizeRtds } from "../normalize/spot.ts";
import { sampleFrames, sampleJson } from "./samples.ts";

const ev = sampleJson<GammaEvent[]>("gamma-event-current.json")[0]!;
const [UP, DOWN] = JSON.parse(ev.markets[0]!.clobTokenIds) as [string, string];
const ctx = (dropMirrored: boolean): ClobContext => ({
  marketId: ev.markets[0]!.conditionId,
  upTokenId: UP,
  downTokenId: DOWN,
  dropMirrored,
});
const clobFrames = sampleFrames("clob-ws-market.ndjson.gz");

const validate = (evs: MarketEvent[]) => evs.forEach((e) => MarketEvent.parse(e));

describe("normalizeClob on the 75 s capture", () => {
  const run = (dropMirrored: boolean) => {
    const all: MarketEvent[] = [];
    let mismatches = 0;
    const unknown: string[] = [];
    for (const f of clobFrames) {
      const r = normalizeClob(f.data, ctx(dropMirrored), 1n);
      all.push(...r.events);
      mismatches += r.mirrorMismatches;
      unknown.push(...r.unknownTypes);
    }
    return { all, mismatches, unknown };
  };

  it("keeps every change when not dropping mirrors, and every event validates", () => {
    const { all, unknown } = run(false);
    validate(all);
    expect(unknown).toEqual([]);
    const changes = all.flatMap((e) => (e.kind === "book_delta" ? e.payload.changes : []));
    expect(changes.length).toBe(31_644 * 2);
    expect(all.filter((e) => e.kind === "trade")).toHaveLength(24);
    expect(all.filter((e) => e.kind === "book_snapshot")).toHaveLength(50);
  });

  it("drops exactly the mirrored DOWN side with zero mismatches", () => {
    const { all, mismatches } = run(true);
    validate(all);
    expect(mismatches).toBe(0);
    const changes = all.flatMap((e) => (e.kind === "book_delta" ? e.payload.changes : []));
    expect(changes.length).toBe(31_644);
    expect(changes.every((c) => c.token === "UP")).toBe(true);
    expect(all.filter((e) => e.kind === "book_snapshot").every((e) => e.token === "UP")).toBe(true);
    // trades print once on the taker's token, so both tokens must survive
    const tradeTokens = new Set(all.filter((e) => e.kind === "trade").map((e) => e.token));
    expect(tradeTokens).toEqual(new Set(["UP", "DOWN"]));
  });

  it("maps a real trade print", () => {
    const { all } = run(true);
    const t = all.find((e) => e.kind === "trade")!;
    expect(t).toMatchObject({
      token: "DOWN",
      exchangeTs: 1790284048757,
      payload: { price: 0.68, size: 5, side: "SELL", feeRateBps: 0 },
    });
  });
});

describe("normalizeClob edge cases", () => {
  const msg = (changes: object[]) =>
    JSON.stringify({ event_type: "price_change", timestamp: "1", market: "m", price_changes: changes });

  it("keeps and counts a DOWN change that is not a mirror", () => {
    const r = normalizeClob(
      msg([
        { asset_id: UP, price: "0.31", size: "233", side: "BUY", best_bid: "0.31", best_ask: "0.32" },
        { asset_id: DOWN, price: "0.69", size: "200", side: "SELL", best_bid: "0.68", best_ask: "0.69" },
      ]),
      ctx(true),
      1n,
    );
    expect(r.mirrorMismatches).toBe(1);
    expect(r.events[0]!.kind === "book_delta" && r.events[0]!.payload.changes).toHaveLength(2);
  });

  it("ignores PONG and other assets; keeps unknown event types verbatim as venue_raw", () => {
    expect(normalizeClob("PONG", ctx(true), 1n).events).toEqual([]);
    const raw = { event_type: "new_thing", asset_id: UP, timestamp: "5", x: 1 };
    const r = normalizeClob(
      JSON.stringify([raw, { event_type: "last_trade_price", asset_id: "x", price: "0.5", size: "1", side: "BUY", timestamp: "1" }]),
      ctx(true),
      1n,
    );
    validate(r.events);
    expect(r.unknownTypes).toEqual(["new_thing"]);
    expect(r.events).toEqual([
      { kind: "venue_raw", marketId: ctx(true).marketId, exchangeTs: 5, recvTs: 1n, payload: { feed: "clob", eventType: "new_thing", data: JSON.stringify(raw) } },
    ]);
  });

  it("normalizes tick_size_change, and falls back to venue_raw if its shape is unexpected", () => {
    const ok = normalizeClob(
      JSON.stringify({ event_type: "tick_size_change", asset_id: DOWN, market: "m", old_tick_size: "0.01", new_tick_size: "0.001", timestamp: "7" }),
      ctx(true),
      1n,
    );
    validate(ok.events);
    expect(ok.events[0]).toMatchObject({ kind: "tick_size_change", token: "DOWN", exchangeTs: 7, payload: { oldTickSize: 0.01, newTickSize: 0.001 } });
    const odd = normalizeClob(JSON.stringify({ event_type: "tick_size_change", asset_id: UP, timestamp: "7" }), ctx(true), 1n);
    expect(odd.events[0]!.kind).toBe("venue_raw");
  });

  it("treats empty best_bid as null", () => {
    const r = normalizeClob(msg([{ asset_id: UP, price: "0.01", size: "0", side: "BUY", best_bid: "", best_ask: "0.02" }]), ctx(true), 1n);
    validate(r.events);
    expect(r.events[0]!.kind === "book_delta" && r.events[0]!.payload.changes[0]!.bestBid).toBeNull();
  });
});

describe("spot + chainlink normalizers", () => {
  const spot = sampleFrames("spot-feeds.ndjson");
  const rtds = sampleFrames("boundary-feeds.ndjson.gz").filter((f) => f.src === "rtds");

  it("normalizes every Binance frame", () => {
    const evs = spot.filter((f) => f.src === "binance").flatMap((f) => normalizeBinance(f.data, 1n, f.recvMs));
    validate(evs);
    expect(evs).toHaveLength(101);
    expect(evs.filter((e) => e.kind === "spot" && e.payload.type === "trade")).toHaveLength(7);
  });

  it("maps Binance aggTrade m=false to a taker BUY", () => {
    const f = spot.find((x) => x.data.includes("aggTrade") && x.data.includes('"m":false'))!;
    expect(normalizeBinance(f.data, 1n, 0)[0]!.payload).toMatchObject({ type: "trade", side: "BUY" });
  });

  it("splits a Coinbase ticker into trade + bbo and skips control messages", () => {
    const evs = spot.filter((f) => f.src === "coinbase").flatMap((f) => normalizeCoinbase(f.data, 1n));
    validate(evs);
    expect(evs).toHaveLength(23 * 2);
  });

  it("normalizes live Chainlink ticks with full accuracy and the subscribe backfill", () => {
    const evs = rtds.flatMap((f) => normalizeRtds(f.data, "btc/usd", 1n));
    validate(evs);
    const live = evs.filter((e) => e.kind === "res_price" && !e.payload.backfill);
    const backfill = evs.filter((e) => e.kind === "res_price" && e.payload.backfill);
    expect(live).toHaveLength(420);
    expect(live.every((e) => e.kind === "res_price" && e.payload.scaled)).toBe(true);
    expect(backfill).toHaveLength(59);
    expect(normalizeRtds(rtds[1]!.data, "eth/usd", 1n)).toEqual([]);
  });
});
