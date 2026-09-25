import { loadConfig, MarketStates, ReplayClock, type FillMode, type MarketEvent, type Side, type Token } from "@rain/pm-harness-core";
import { describe, expect, it } from "vitest";
import { FillSim, type FillInfo } from "./fill-sim.ts";

const cfg = loadConfig(new URL("../../../config/default.yaml", import.meta.url).pathname);
const ms = (t: number) => BigInt(Math.round(t * 1e6));

function setup(mode: FillMode = "base", over: Partial<(typeof cfg.sim.modes)["base"]> = {}) {
  const clock = new ReplayClock();
  const states = new MarketStates();
  const fills: FillInfo[] = [];
  const sim = new FillSim({ mode, params: { ...cfg.sim.modes[mode], ...over }, clock, states, complementaryMatching: true, onFill: (f) => fills.push(f) });
  const feed = (t: number, ev: Omit<MarketEvent, "recvTs" | "exchangeTs">) => {
    const e = { ...ev, marketId: "m", exchangeTs: t, recvTs: ms(t) } as MarketEvent;
    clock.advanceTo(e.recvTs);
    sim.onEvent(e);
    states.apply(e);
  };
  const snapshot = (t: number, bids: [number, number][], asks: [number, number][]) =>
    feed(t, { kind: "book_snapshot", token: "UP", payload: { bids: bids.map(([price, size]) => ({ price, size })), asks: asks.map(([price, size]) => ({ price, size })), hash: "h" } });
  const trade = (t: number, token: Token, side: Side, price: number, size: number) =>
    feed(t, { kind: "trade", token, payload: { price, size, side, feeRateBps: 0, txHash: "x" } });
  const level = (t: number, token: Token, side: Side, price: number, size: number) =>
    feed(t, { kind: "book_delta", payload: { changes: [{ token, side, price, size, bestBid: null, bestAsk: null }] } });
  const at = (t: number) => clock.advanceTo(ms(t));
  return { clock, states, sim, fills, snapshot, trade, level, at };
}

describe("FillSim", () => {
  it("reproduces the PLAN.md §4.5 sequence: queue, cancel sent, toxic fill during cancel latency", () => {
    const s = setup("base", { ackLatencyMs: 150, cancelLatencyMs: 150, queuePadFrac: 0 });
    s.snapshot(0, [[0.53, 320]], [[0.55, 100]]);
    s.at(0);
    const o = s.sim.place("m", "BUY", 0.53, 50);
    s.at(150);
    expect(o.status).toBe("Live");
    expect(o.queueAheadAtLive).toBe(320);
    s.trade(500, "UP", "SELL", 0.53, 200);
    expect(o.queueAhead).toBe(120);
    s.at(1200);
    s.sim.cancel(o);
    expect(o.status).toBe("PendingCancel");
    s.trade(1250, "UP", "SELL", 0.53, 180); // queueAhead −60 → fill 50
    expect(s.fills).toHaveLength(1);
    expect(s.fills[0]).toMatchObject({ size: 50, price: 0.53, duringCancelLatency: true, through: false });
    expect(o.status).toBe("Filled");
    s.at(1400); // cancel lands on a filled order: nothing happens
    expect(o.status).toBe("Filled");
    expect(s.sim.stats).toMatchObject({ fills: 1, cancelLatencyFills: 1, cancelled: 0 });
  });

  it("is not live (and cannot fill) until the ack latency has passed", () => {
    const s = setup("pessimistic");
    s.snapshot(0, [[0.5, 0]], [[0.6, 10]]);
    const o = s.sim.place("m", "BUY", 0.5, 10);
    s.trade(100, "UP", "SELL", 0.4, 100); // would be a trade-through, but we are not live yet (400 ms)
    expect(s.fills).toHaveLength(0);
    s.trade(500, "UP", "SELL", 0.4, 100);
    expect(s.fills[0]).toMatchObject({ size: 10, through: true });
    expect(o.status).toBe("Filled");
  });

  it("rejects a post-only order that would cross at the moment it goes live", () => {
    const s = setup("base");
    s.snapshot(0, [[0.5, 10]], [[0.52, 10]]);
    const o = s.sim.place("m", "BUY", 0.51, 10);
    s.level(50, "UP", "SELL", 0.51, 20); // an ask arrives at our price before we are live
    s.at(200);
    expect(o.status).toBe("Rejected");
    expect(s.sim.stats.rejected).toBe(1);
  });

  it("matches DOWN prints against UP queues at 1 − p (unified book)", () => {
    const s = setup("optimistic", { queuePadFrac: 0 });
    s.snapshot(0, [[0.3, 0]], [[0.4, 100]]);
    const ask = s.sim.place("m", "SELL", 0.4, 30); // UP ask 0.40 == DOWN bid 0.60
    s.at(100);
    expect(ask.queueAhead).toBe(100);
    s.trade(200, "DOWN", "SELL", 0.6, 110); // DOWN taker SELL @0.60 == UP taker BUY @0.40
    expect(s.fills[0]).toMatchObject({ size: 10 });
    s.trade(300, "DOWN", "SELL", 0.59, 5); // == UP BUY @0.41: through our 0.40 ask
    expect(s.fills[1]).toMatchObject({ size: 20, through: true });
  });

  it("applies cancels ahead of us per mode, never double-counting prints", () => {
    const run = (mode: FillMode) => {
      const s = setup(mode, { queuePadFrac: 0 });
      s.snapshot(0, [[0.5, 100]], [[0.6, 10]]);
      const o = s.sim.place("m", "BUY", 0.5, 10);
      s.at(500);
      s.level(550, "UP", "BUY", 0.5, 200); // 100 joins behind us
      s.trade(600, "UP", "SELL", 0.5, 20); // print: ahead 80, level 180 (no level update is sent for it)
      s.level(700, "UP", "BUY", 0.5, 140); // shows 140: the other 40 left by cancels
      return o.queueAhead;
    };
    expect(run("pessimistic")).toBe(80); // no cancels ahead of us
    expect(run("base")).toBe(60); // half of the 40 were ahead
    expect(run("optimistic")).toBeCloseTo(80 - (40 * 80) / 180, 9); // pro-rata by position
  });

  it("puts new size at our level behind us, and pads the queue in pessimistic mode", () => {
    const s = setup("pessimistic");
    s.snapshot(0, [[0.5, 100]], [[0.6, 10]]);
    const o = s.sim.place("m", "BUY", 0.5, 10);
    s.at(400);
    expect(o.queueAhead).toBeCloseTo(110, 9);
    s.level(500, "UP", "BUY", 0.5, 300);
    expect(o.queueAhead).toBeCloseTo(110, 9);
  });

  it("cancels only after the cancel latency, and closes everything at market close", () => {
    const s = setup("base");
    s.snapshot(0, [[0.5, 0]], [[0.6, 10]]);
    const a = s.sim.place("m", "BUY", 0.5, 10);
    const b = s.sim.place("m", "BUY", 0.49, 10);
    s.at(200);
    s.sim.cancel(a);
    s.at(349);
    expect(a.status).toBe("PendingCancel");
    s.at(350);
    expect(a.status).toBe("Cancelled");
    s.clock.advanceTo(ms(400));
    s.sim.onEvent({ kind: "market_close", marketId: "m", exchangeTs: 400, recvTs: ms(400), payload: { windowEnd: 400 } });
    expect(b.status).toBe("Cancelled");
    expect(s.sim.openOrders("m")).toHaveLength(0);
  });

  it("goes Live → PartiallyFilled → Filled across prints", () => {
    const s = setup("optimistic", { queuePadFrac: 0 });
    s.snapshot(0, [[0.5, 10]], [[0.6, 10]]);
    const o = s.sim.place("m", "BUY", 0.5, 30);
    s.at(100);
    s.trade(200, "UP", "SELL", 0.5, 25); // 10 ahead, then 15 for us
    expect(o.status).toBe("PartiallyFilled");
    expect(o.remaining).toBe(15);
    s.trade(300, "UP", "SELL", 0.5, 15);
    expect(o.status).toBe("Filled");
    expect(s.fills.map((f) => f.size)).toEqual([15, 15]);
  });

  it("cancels an order still in flight (PendingNew) once both latencies have run", () => {
    const s = setup("base");
    s.snapshot(0, [[0.5, 0]], [[0.6, 10]]);
    const o = s.sim.place("m", "BUY", 0.5, 10);
    s.at(50);
    s.sim.cancel(o);
    s.at(150);
    expect(o.status).toBe("PendingCancel"); // live but already cancelling: prints can still hit it
    s.trade(160, "UP", "SELL", 0.5, 5);
    expect(s.fills[0]).toMatchObject({ size: 5, duringCancelLatency: true });
    s.at(200);
    expect(o.status).toBe("Cancelled");
  });

  it("never changes the book it trades against (rule 7)", () => {
    const s = setup("optimistic");
    s.snapshot(0, [[0.5, 100]], [[0.6, 100]]);
    const before = s.states.get("m").book.digest();
    s.sim.place("m", "BUY", 0.5, 50);
    s.at(100);
    s.trade(200, "UP", "SELL", 0.4, 10);
    expect(s.states.get("m").book.digest()).toBe(before);
  });
});
