import { loadConfig } from "@rain/pm-harness-core";
import { describe, expect, it } from "vitest";
import { MarketMaker, sanitize, type QuoteContext } from "./strategy.ts";

const base = loadConfig(new URL("../../../config/default.yaml", import.meta.url).pathname);
// fixed params so these tests do not move when the defaults are tuned
const cfg = {
  ...base,
  strategy: { ...base.strategy, halfSpread: 0.01, volSpreadMult: 0.5, skewPerShare: 0.0001, maxInventory: 500, quoteSize: 50, pullBeforeCloseSec: 60, inventoryDecaySec: 0, unwindEdge: 0, fvBand: [0, 1] as [number, number] },
};
const W = 1_000_000;
const ctx = (over: Partial<QuoteContext> = {}): QuoteContext => ({
  marketId: "m",
  nowMs: W + 100_000,
  windowStart: W,
  windowEnd: W + 900_000,
  fv: { p: 0.5, sigma: 1e-4, tau: 800, s: 84_000, s0: 84_000, mean: 84_000, sd: 10 },
  fvVol: 0.004,
  book: { bid: 0.45, bidSize: 100, ask: 0.55, askSize: 100 },
  inventory: 0,
  tickSize: 0.01,
  spotJump: false,
  ...over,
});

describe("MarketMaker", () => {
  const mm = new MarketMaker(cfg);

  it("quotes around FV with half-spread + vol term, on the tick grid", () => {
    // hs = 0.01 + 0.5 × 0.004 = 0.012 → bid floor(0.488) = 0.48, ask ceil(0.512) = 0.52
    expect(mm.quote(ctx())).toEqual({ bid: 0.48, ask: 0.52, size: 50 });
  });

  it("skews against inventory and stops adding risk at the cap", () => {
    const long = mm.quote(ctx({ inventory: 200 }))!; // skew 0.02 down
    expect(long).toMatchObject({ bid: 0.46, ask: 0.5 });
    expect(mm.quote(ctx({ inventory: 500 }))!.bid).toBeNull();
    expect(mm.quote(ctx({ inventory: -500 }))!.ask).toBeNull();
  });

  it("pulls before the window, before close, and on a spot jump", () => {
    expect(mm.quote(ctx({ nowMs: W - 1 }))).toBeNull();
    expect(mm.quote(ctx({ nowMs: W + 900_000 - 59_000 }))).toBeNull();
    expect(mm.quote(ctx({ spotJump: true }))).toBeNull();
  });

  it("never crosses the book (post-only) and never quotes outside (0, 1)", () => {
    const tight = mm.quote(ctx({ book: { bid: 0.49, bidSize: 1, ask: 0.5, askSize: 1 } }))!;
    expect(tight.bid).toBeLessThanOrEqual(0.49);
    expect(tight.ask).toBeGreaterThanOrEqual(0.5);
    expect(sanitize(-0.01, 1.2, ctx({ book: { bid: null, bidSize: 0, ask: null, askSize: 0 } }))).toEqual({ bid: null, ask: null });
  });

  describe("inventory control", () => {
    const ic = new MarketMaker({ ...cfg, strategy: { ...cfg.strategy, maxInventory: 100, quoteSize: 20, skewPerShare: 0.0002, inventoryDecaySec: 300, fvBand: [0.05, 0.95] } });
    const pull = W + 900_000 - 60_000;

    it("shrinks the cap to zero over the last 5 minutes before the pull", () => {
      const early = ctx({ nowMs: pull - 600_000 });
      expect(ic.cap(early)).toBe(100);
      expect(ic.cap(ctx({ nowMs: pull - 150_000 }))).toBeCloseTo(50, 9);
      expect(ic.cap(ctx({ nowMs: pull - 1 }))).toBeLessThan(1);
    });

    it("above the shrinking cap, only works the reducing side at FV, sized to the position", () => {
      // long 60 with 2.5 min to the pull: cap 50 → no bid, ask at FV (skew would otherwise put it lower)
      const q = ic.quote(ctx({ nowMs: pull - 150_000, inventory: 60 }))!;
      expect(q.bid).toBeNull();
      expect(q.ask).toBe(0.5);
      expect(q.size).toBe(20);
      const short = ic.quote(ctx({ nowMs: pull - 150_000, inventory: -12 }))!;
      expect(short).toMatchObject({ ask: 0.52, size: 20 }); // |−12| < cap 50: normal two-sided quoting
      const tinyCap = ic.quote(ctx({ nowMs: pull - 3_000, inventory: -12 }))!; // cap 1
      expect(tinyCap).toMatchObject({ ask: null, bid: 0.5, size: 12 });
    });

    it("never adds when the outcome is nearly decided, but still reduces", () => {
      const decided = ctx({ fv: { ...ctx().fv, p: 0.97 }, book: { bid: 0.95, bidSize: 100, ask: 0.99, askSize: 100 } });
      expect(ic.quote({ ...decided, inventory: 0 })).toEqual({ bid: null, ask: null, size: 20 });
      expect(ic.quote({ ...decided, inventory: 40 })!.bid).toBeNull();
      expect(ic.quote({ ...decided, inventory: 40 })!.ask).not.toBeNull();
    });
  });
});
