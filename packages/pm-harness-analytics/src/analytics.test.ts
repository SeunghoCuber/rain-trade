import { describe, expect, it } from "vitest";
import { analyzeMode, analyzeRun, fvLookup, hourIn, type FillIn, type MarketIn } from "./analyze.ts";
import { blockBootstrap, drawdown, mean, median, quantile, sd, skew, tStat } from "./stats.ts";

describe("stats", () => {
  it("computes basic moments", () => {
    const xs = [1, 2, 3, 4, 10];
    expect(mean(xs)).toBe(4);
    expect(median(xs)).toBe(3);
    expect(quantile(xs, 0.25)).toBe(2);
    expect(sd(xs)).toBeCloseTo(Math.sqrt(12.5), 12);
    expect(skew(xs)).toBeGreaterThan(1);
    expect(tStat(xs)).toBeCloseTo(4 / (Math.sqrt(12.5) / Math.sqrt(5)), 12);
  });

  it("block bootstrap is deterministic, covers the mean, and resamples whole blocks", () => {
    const blocks = [[1, 1, 1], [2, 2], [3], [4, 4, 4, 4], [5]];
    const a = blockBootstrap(blocks, mean, 2000, 7);
    expect(blockBootstrap(blocks, mean, 2000, 7)).toEqual(a);
    expect(a.estimate).toBeCloseTo(mean(blocks.flat()), 12);
    expect(a.lo95).toBeLessThan(a.estimate);
    expect(a.hi95).toBeGreaterThan(a.estimate);
    expect(a.pPositive).toBe(1);
    expect(a.blocks).toBe(5);
  });

  it("finds max drawdown, its length and recovery", () => {
    const d = drawdown([1, 3, 2, 0, 1, 4, 5]);
    expect(d.maxDd).toBe(-3);
    expect(d.maxDdSteps).toBe(2);
    expect(d.recoverSteps).toBe(2);
    expect(d.underwater).toEqual([0, 0, -1, -3, -2, 0, 0]);
  });
});

const H = 3_600_000;
const market = (i: number, over: Partial<MarketIn> = {}): MarketIn => ({
  mode: "base",
  marketId: `m${i}`,
  slug: `s${i}`,
  windowStart: i * H,
  outcome: 1,
  pnlTrading: 10,
  pnlSpread: 12,
  pnlAdverse: -3,
  pnlInventory: 1,
  rebateEst: 1,
  fees: 0,
  volumeFilled: 100,
  fills: 2,
  cancelLatencyFills: 0,
  maxAbsInventory: 50,
  capitalUsed: 40,
  quoteUptimePct: 80,
  realizedVol: 1e-4 * (1 + i),
  excluded: false,
  flags: "",
  ...over,
});
const fill = (i: number, side: "BUY" | "SELL", price: number, over: Partial<FillIn> = {}): FillIn => ({
  mode: "base",
  marketId: `m${i}`,
  side,
  price,
  size: 50,
  ts: i * H + 60_000,
  secondsToClose: 840,
  fvAtFill: 0.5,
  inventoryBefore: 0,
  duringCancelLatency: false,
  spotMove1sBp: 0,
  outcome: 1,
  ...over,
});

describe("analyzeMode", () => {
  const markets = [market(0), market(1), market(2, { excluded: true, pnlTrading: -1000 }), market(3, { pnlTrading: -5, rebateEst: 0 })];
  const fills = [fill(0, "BUY", 0.48), fill(0, "SELL", 0.52), fill(1, "BUY", 0.49), fill(2, "BUY", 0.1)];
  const fv = new Map([
    ["m0", [{ ts: 0, fv: 0.5 }, { ts: 60_000 + 5_000, fv: 0.6 }]],
    ["m1", [{ ts: 0, fv: 0.5 }]],
  ]);
  const a = analyzeMode("base", { markets, fills, fv, draws: 500 });

  it("excludes flagged markets from headline numbers", () => {
    expect(a.markets).toBe(3);
    expect(a.excludedMarkets).toBe(1);
    expect(a.netPnl).toBeCloseTo(11 + 11 - 5, 12);
    expect(a.fills).toBe(3); // the excluded market's fill is dropped
  });

  it("computes edge per share, hit rate and per-market stats", () => {
    expect(a.edgeCents).toBeCloseTo((100 * 17) / 300, 12);
    expect(a.edgeCentsExRebates).toBeCloseTo((100 * 15) / 300, 12);
    expect(a.hitRate).toBeCloseTo(2 / 3, 12);
    expect(a.perMarket.median).toBe(11);
    expect(a.bootstrap.blockBy).toBe("hour");
  });

  it("computes markouts from the FV series and at settlement", () => {
    const five = a.markouts.find((m) => m.horizon === "5s")!;
    // m0: BUY 0.48 → (0.6−0.48), SELL 0.52 → −(0.6−0.52); m1: BUY 0.49 → (0.5−0.49)
    expect(five.cents).toBeCloseTo((100 * (0.12 - 0.08 + 0.01) * 50) / 150, 9);
    const settle = a.markouts.find((m) => m.horizon === "settle")!;
    expect(settle.cents).toBeCloseTo((100 * ((1 - 0.48) - (1 - 0.52) + (1 - 0.49)) * 50) / 150, 9);
  });

  it("breaks results down, ordering numeric buckets numerically", () => {
    const sides = a.breakdowns.filter((b) => b.dimension === "side").map((b) => b.bucket);
    expect(sides).toEqual(["BUY", "SELL"]);
    const minutes = a.breakdowns.filter((b) => b.dimension === "minute").map((b) => Number(b.bucket));
    expect(minutes).toEqual([...minutes].sort((x, y) => x - y));
  });

  it("builds the per-run views used by the dashboard", () => {
    const r = analyzeRun("r", { markets, fills, fv, draws: 200 });
    expect(r.modes.map((m) => m.mode)).toEqual(["optimistic", "base", "pessimistic"]);
    expect(r.heatMinuteFv.length).toBeGreaterThan(0);
    expect(r.spotVsMarkout.length).toBe(3);
  });
});

describe("fvLookup", () => {
  it("steps: last sample at or before ts, first sample before the series", () => {
    const s = [{ ts: 10, fv: 0.1 }, { ts: 20, fv: 0.2 }];
    expect(fvLookup(s, 5)).toBe(0.1);
    expect(fvLookup(s, 19)).toBe(0.1);
    expect(fvLookup(s, 20)).toBe(0.2);
    expect(fvLookup(s, 99)).toBe(0.2);
  });
});

describe("hourIn", () => {
  it("converts to the display zone, following daylight saving", () => {
    expect(hourIn(Date.parse("2026-09-25T21:00:00Z"), "America/Los_Angeles")).toBe(14); // PDT, UTC−7
    expect(hourIn(Date.parse("2026-12-25T21:00:00Z"), "America/Los_Angeles")).toBe(13); // PST, UTC−8
    expect(hourIn(Date.parse("2026-09-25T07:00:00Z"), "America/Los_Angeles")).toBe(0);
    expect(hourIn(Date.parse("2026-09-25T21:00:00Z"), "UTC")).toBe(21);
  });
});
