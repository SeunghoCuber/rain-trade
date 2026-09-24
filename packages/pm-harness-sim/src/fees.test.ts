import { describe, expect, it } from "vitest";
import type { FeeSchedule } from "@rain/pm-harness-core";
import { makerFeeEquivalent, makerRebateEst, takerFee } from "./fees.ts";

const crypto: FeeSchedule = { rate: 0.07, exponent: 1, takerOnly: true, rebateRate: 0.2 };

describe("takerFee", () => {
  it("matches the documented crypto peak: 100 shares @0.50 = $1.75", () => {
    expect(takerFee(100, 0.5, crypto)).toBe(1.75);
  });

  it("is symmetric around 0.5", () => {
    expect(takerFee(100, 0.3, crypto)).toBe(takerFee(100, 0.7, crypto));
  });

  it("rounds to 5 decimals and drops sub-minimum fees", () => {
    expect(takerFee(1, 0.001, crypto)).toBe(0.00007);
    expect(takerFee(0.01, 0.001, crypto)).toBe(0);
  });
});

describe("makerRebateEst", () => {
  it("returns rebateRate * our fee when we are the only maker", () => {
    const fe = makerFeeEquivalent(100, 0.5, crypto);
    expect(makerRebateEst(fe, fe, fe, crypto)).toBeCloseTo(0.35, 10);
  });

  it("is zero with no maker volume", () => {
    expect(makerRebateEst(0, 0, 10, crypto)).toBe(0);
  });
});
