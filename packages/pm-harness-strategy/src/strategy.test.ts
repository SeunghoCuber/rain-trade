import { loadConfig } from "@rain/pm-harness-core";
import { describe, expect, it } from "vitest";
import { MarketMaker, sanitize, type QuoteContext } from "./strategy.ts";

const cfg = loadConfig(new URL("../../../config/default.yaml", import.meta.url).pathname);
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
});
