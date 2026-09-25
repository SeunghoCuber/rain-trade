import { describe, expect, it } from "vitest";
import { Ledger } from "./ledger.ts";

const fees = { rate: 0.07, exponent: 1, takerOnly: true, rebateRate: 0.2 };

describe("Ledger", () => {
  it("buys UP, sells what it holds, and turns further sells into DOWN at 1−p", () => {
    const l = new Ledger({ mergePairs: false, fees });
    l.applyFill("BUY", 0.4, 10); // −4
    l.applyFill("SELL", 0.45, 15); // sell 10 UP (+4.5), buy 5 DOWN at 0.55 (−2.75)
    expect(l.up).toBe(0);
    expect(l.down).toBe(5);
    expect(l.inventory).toBe(-5);
    expect(l.cash).toBeCloseTo(-4 + 4.5 - 2.75, 12);
    expect(l.settle("DOWN")).toBeCloseTo(-2.25 + 5, 12);
  });

  it("merges UP+DOWN pairs into $1 and matches Σ d·(Y − p)·q at settlement", () => {
    const l = new Ledger({ mergePairs: true, fees });
    const fills: ["BUY" | "SELL", number, number][] = [["SELL", 0.6, 20], ["BUY", 0.55, 30], ["SELL", 0.58, 5]];
    for (const [s, p, q] of fills) l.applyFill(s, p, q);
    expect(l.merged).toBe(20);
    expect(l.inventory).toBe(5);
    for (const y of [0, 1] as const) {
      const c = new Ledger({ mergePairs: true, fees });
      for (const [s, p, q] of fills) c.applyFill(s, p, q);
      const expected = fills.reduce((a, [s, p, q]) => a + (s === "BUY" ? 1 : -1) * (y - p) * q, 0);
      expect(c.settle(y ? "UP" : "DOWN")).toBeCloseTo(expected, 12);
    }
  });

  it("tracks capital, inventory extremes and the rebate estimate", () => {
    const l = new Ledger({ mergePairs: true, fees });
    l.applyFill("BUY", 0.5, 100);
    expect(l.minCash).toBe(-50);
    expect(l.maxAbsInventory).toBe(100);
    expect(l.rebateEstimate()).toBeCloseTo(0.2 * 100 * 0.07 * 0.25, 12);
  });
});
