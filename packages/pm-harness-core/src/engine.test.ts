import { describe, expect, it } from "vitest";
import { Book } from "./book.ts";
import { AsyncEventQueue, ReplayClock, runReplay } from "./event-clock.ts";
import type { MarketEvent } from "./events.ts";
import { MarketStates } from "./market-state.ts";
import { Rng } from "./rng.ts";

const ev = (ms: number, extra: Partial<MarketEvent> = {}): MarketEvent =>
  ({ kind: "spot", exchangeTs: ms, recvTs: BigInt(ms) * 1_000_000n, payload: { type: "trade", source: "binance", price: 1, size: 1, side: "BUY" }, ...extra }) as MarketEvent;

describe("Rng", () => {
  it("is deterministic per seed and forks independent streams", () => {
    const a = new Rng(42), b = new Rng(42), c = new Rng(43);
    const xs = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(xs);
    expect(c.next()).not.toBe(xs[0]);
    expect(new Rng(42).fork("base").next()).toBe(new Rng(42).fork("base").next());
    expect(new Rng(42).fork("base").next()).not.toBe(new Rng(42).fork("pessimistic").next());
  });

  it("is roughly uniform", () => {
    const r = new Rng("uniform");
    const n = 100_000;
    let sum = 0;
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < n; i++) {
      const x = r.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      sum += x;
      buckets[Math.floor(x * 10)]++;
    }
    expect(sum / n).toBeCloseTo(0.5, 2);
    for (const b of buckets) expect(Math.abs(b - n / 10)).toBeLessThan(500);
  });
});

describe("ReplayClock + runReplay", () => {
  it("fires due timers before the event at that time, in schedule order, and supports cancel", async () => {
    const clock = new ReplayClock();
    const log: string[] = [];
    await runReplay([ev(100), ev(200), ev(300)], clock, (e, c) => {
      const t = Number(e.recvTs / 1_000_000n);
      log.push(`ev${t}`);
      if (t === 100) {
        c.schedule(200_000_000n, () => log.push("timer@200a")); // same time as the next event: fires first
        c.schedule(250_000_000n, () => log.push(`timer@250 now=${c.now()}`));
        const id = c.schedule(150_000_000n, () => log.push("cancelled"));
        c.cancel(id);
        c.schedule(200_000_000n, () => log.push("timer@200b"));
      }
    });
    expect(log).toEqual(["ev100", "timer@200a", "timer@200b", "ev200", "timer@250 now=250000000", "ev300"]);
    expect(clock.pendingTimers).toBe(0);
  });

  it("runs past-due timers at the current time and counts out-of-order events", async () => {
    const clock = new ReplayClock();
    const log: string[] = [];
    const stats = await runReplay([ev(100), ev(90), ev(110)], clock, (e, c) => {
      log.push(`ev@${c.now() / 1_000_000n}`);
      if (e.recvTs === 100_000_000n) c.schedule(1n, () => log.push(`late timer@${c.now() / 1_000_000n}`));
    });
    expect(stats.outOfOrder).toBe(1);
    expect(log).toEqual(["ev@100", "late timer@100", "ev@100", "ev@110"]);
  });
});

describe("AsyncEventQueue", () => {
  it("delivers pushed items in order to an async consumer and ends on close", async () => {
    const q = new AsyncEventQueue<number>();
    const got: number[] = [];
    const consumer = (async () => {
      for await (const x of q) got.push(x);
    })();
    q.push(1);
    await new Promise((r) => setTimeout(r, 5));
    q.push(2);
    q.push(3);
    q.close();
    await consumer;
    expect(got).toEqual([1, 2, 3]);
  });
});

describe("Book", () => {
  it("stores one unified book: DOWN changes mirror into UP and back", () => {
    const b = new Book();
    b.setLevel("UP", "BUY", 0.3, 100);
    b.setLevel("DOWN", "BUY", 0.69, 50); // == UP ask 0.31
    expect(b.quote("UP")).toEqual({ bid: 0.3, bidSize: 100, ask: 0.31, askSize: 50 });
    expect(b.quote("DOWN")).toEqual({ bid: 0.69, bidSize: 50, ask: 0.7, askSize: 100 });
    expect(b.sizeAt("DOWN", "SELL", 0.7)).toBe(100);
    b.setLevel("UP", "SELL", 0.31, 0);
    expect(b.quote("DOWN").bid).toBeNull();
  });

  it("prunes levels the reported best says were consumed by a match", () => {
    const b = new Book();
    b.applySnapshot("UP", [{ price: 0.31, size: 10 }, { price: 0.3, size: 20 }], [{ price: 0.33, size: 5 }]);
    // a sell crossed the 0.31 bid and rests at 0.31; the venue reports best 0.30/0.31 but never removes the bid
    b.applyChange({ token: "UP", side: "SELL", price: 0.31, size: 22, bestBid: 0.3, bestAsk: 0.31 });
    expect(b.pruneToReported("UP", 0.3, 0.31)).toBe(1);
    expect(b.quote("UP")).toEqual({ bid: 0.3, bidSize: 20, ask: 0.31, askSize: 22 });
    // DOWN-reported best maps back correctly
    expect(b.pruneToReported("DOWN", 0.69, 0.7)).toBe(0);
  });

  it("diffs snapshots and separates near-top differences", () => {
    const b = new Book();
    b.applySnapshot("UP", [{ price: 0.5, size: 10 }, { price: 0.2, size: 5 }], [{ price: 0.51, size: 7 }]);
    expect(b.diffSnapshot("UP", [{ price: 0.5, size: 10 }, { price: 0.2, size: 5 }], [{ price: 0.51, size: 7 }])).toEqual({ total: 0, nearTop: 0 });
    expect(b.diffSnapshot("UP", [{ price: 0.5, size: 9 }, { price: 0.2, size: 4 }], [{ price: 0.51, size: 7 }])).toEqual({ total: 2, nearTop: 1 });
    expect(b.digest()).toBe("b[200000:5,500000:10]a[510000:7]");
  });
});

describe("MarketStates", () => {
  const open = (ms: number): MarketEvent => ({
    kind: "market_open",
    marketId: "m",
    exchangeTs: ms,
    recvTs: BigInt(ms) * 1_000_000n,
    payload: { slug: "s", upTokenId: "u", downTokenId: "d", windowStart: 0, windowEnd: 900_000, tickSize: 0.01, minOrderSize: 5, feeSchedule: { rate: 0.07, exponent: 1, takerOnly: true, rebateRate: 0.2 } },
  });
  const snap = (ms: number, bid: number, ask: number): MarketEvent => ({
    kind: "book_snapshot",
    marketId: "m",
    token: "UP",
    exchangeTs: ms,
    recvTs: BigInt(ms) * 1_000_000n,
    payload: { bids: [{ price: bid, size: 10 }], asks: [{ price: ask, size: 10 }], hash: "h" },
  });
  const delta = (ms: number, price: number, size: number, bestBid: number, bestAsk: number): MarketEvent => ({
    kind: "book_delta",
    marketId: "m",
    exchangeTs: ms,
    recvTs: BigInt(ms) * 1_000_000n,
    payload: { changes: [{ token: "UP", side: "BUY", price, size, bestBid, bestAsk }] },
  });

  it("verifies deltas against reported best and treats venue empty-side sentinels (0 / 1) as empty", () => {
    const s = new MarketStates({ verify: true });
    for (const e of [open(0), snap(1, 0.4, 0.6), delta(2, 0.45, 5, 0.45, 0.6)]) s.apply(e);
    expect(s.checks).toMatchObject({ bestChecked: 1, bestMismatches: 0 });
    s.apply({ ...delta(3, 0.45, 0, 0.4, 0.6) });
    s.apply({
      kind: "book_delta",
      marketId: "m",
      exchangeTs: 4,
      recvTs: 4_000_000n,
      payload: { changes: [{ token: "UP", side: "SELL", price: 0.6, size: 0, bestBid: 0.4, bestAsk: 1 }] },
    });
    expect(s.checks.bestMismatches).toBe(0);
    expect(s.get("m").book.quote().ask).toBeNull();
  });

  it("stops trusting the book after a gap or a re-registration until the next snapshot", () => {
    const s = new MarketStates({ verify: true });
    for (const e of [open(0), snap(1, 0.4, 0.6)]) s.apply(e);
    s.apply({ kind: "feed_gap", marketId: "m", exchangeTs: 2, recvTs: 2_000_000n, payload: { feed: "clob", gapMs: 5000, reason: "reconnect" } });
    expect(s.get("m").synced).toBe(false);
    s.apply(snap(3, 0.3, 0.7));
    expect(s.checks.snapshotsChecked).toBe(0); // not compared: we knew we were stale
    expect(s.get("m").synced).toBe(true);
    s.apply(open(4));
    expect(s.get("m").synced).toBe(false);
  });

  it("tracks tick size changes per token", () => {
    const s = new MarketStates();
    s.apply(open(0));
    s.apply({ kind: "tick_size_change", marketId: "m", token: "DOWN", exchangeTs: 1, recvTs: 1n, payload: { oldTickSize: 0.01, newTickSize: 0.001 } });
    expect(s.get("m").tickSize).toEqual({ UP: 0.01, DOWN: 0.001 });
  });
});
