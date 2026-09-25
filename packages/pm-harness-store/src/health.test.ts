import { describe, expect, it } from "vitest";
import { HealthAccumulator } from "./health.ts";
import { marketEvents, testConfig, W0, type MarketOpts } from "./fixtures.ts";

const cfg = testConfig("unused");
const judge = (o: MarketOpts = {}, now = W0 + 3_600_000) => {
  const acc = new HealthAccumulator(cfg);
  for (const e of marketEvents(o)) acc.add(e);
  const [h] = acc.finish(W0, W0 + 86_400_000, now);
  return h!;
};

describe("HealthAccumulator", () => {
  it("passes a clean, fully recorded market and reproduces settlement", () => {
    const h = judge();
    expect(h.flags).toEqual([]);
    expect(h.excluded).toBe(false);
    expect(h.clTicks).toBe(900);
    expect(h.s0).toBe(84_000);
    expect(h.s1).toBe(84_010);
    expect(h.ourOutcome).toBe("UP");
    expect(h.s0Diff).toBe(0);
    expect(h.deltas).toBeGreaterThan(1700);
  });

  it("marks an unfinished window OPEN and judges nothing else", () => {
    const h = judge({}, W0 + 60_000);
    expect(h.flags).toEqual(["OPEN"]);
    expect(h.excluded).toBe(true);
  });

  it("flags a recorder outage inside the window as GAP (no feed_gap event needed)", () => {
    const h = judge({ holes: [[W0 + 100_000, W0 + 103_500]] });
    expect(h.recHoleMs).toBeGreaterThanOrEqual(3_000);
    expect(h.flags).toContain("GAP");
    expect(h.excluded).toBe(true);
  });

  it("ignores short holes and holes outside the window", () => {
    expect(judge({ holes: [[W0 + 100_000, W0 + 101_000]] }).flags).toEqual([]);
    expect(judge({ holes: [[W0 - 30_000, W0 - 20_000]] }).flags).toEqual([]);
  });

  it("does not exclude for an RTDS-only stall; reports low Chainlink coverage instead", () => {
    const acc = new HealthAccumulator(cfg);
    for (const e of marketEvents()) {
      // drop 60 s of Chainlink ticks mid-window, and record the stall like the recorder does
      if (e.kind === "res_price" && e.exchangeTs >= W0 + 200_000 && e.exchangeTs < W0 + 260_000) continue;
      acc.add(e);
    }
    acc.add({ kind: "feed_gap", exchangeTs: W0 + 260_000, recvTs: BigInt(W0 + 260_000) * 1_000_000n, payload: { feed: "rtds:chainlink", gapMs: 60_000, reason: "silence" } });
    const [h] = acc.finish(W0, W0 + 86_400_000, W0 + 3_600_000);
    expect(h!.flags).toEqual(["CLTICKS"]);
    expect(h!.excluded).toBe(false);
  });

  it("flags LATE when book data starts after the window opened", () => {
    const h = judge({ joinLateMs: 60_000 });
    expect(h.lateSec).toBeCloseTo(60, 0);
    expect(h.flags).toContain("LATE");
  });

  it("flags NORES until the official resolution arrives", () => {
    const h = judge({ resolution: null });
    expect(h.flags).toEqual(["NORES"]);
    expect(h.excluded).toBe(true);
  });

  it("flags SETTLE when our outcome disagrees with the official one, TWAPΔ only beyond tolerance", () => {
    const settle = judge({ resolution: { outcome: "DOWN", priceToBeat: 84_000, finalPrice: 84_010 } });
    expect(settle.flags).toEqual(["SETTLE"]);
    const small = judge({ resolution: { outcome: "UP", priceToBeat: 84_000.5, finalPrice: 84_010 } });
    expect(small.flags).toEqual([]);
    const big = judge({ resolution: { outcome: "UP", priceToBeat: 84_002, finalPrice: 84_010 } });
    expect(big.flags).toEqual(["TWAPΔ"]);
    expect(big.excluded).toBe(false);
  });

  it("applies the configured tie rule", () => {
    expect(judge({ p0: 84_000, p1: 84_000 }).ourOutcome).toBe("UP");
  });
});
