import type { FeeSchedule } from "@rain/pm-harness-core";

/** Fee-curve weight shared by taker fees and maker fee-equivalents: rate * (p(1-p))^exponent per share. */
function feePerShare(price: number, s: FeeSchedule): number {
  return s.rate * (price * (1 - price)) ** s.exponent;
}

/** Polymarket rounds fees to 5 decimals (min 0.00001 USDC). */
function round5(x: number): number {
  return Math.round(x * 1e5) / 1e5;
}

/** Taker fee in USDC for `size` shares at `price`. Makers pay nothing when `takerOnly`. */
export function takerFee(size: number, price: number, s: FeeSchedule): number {
  return round5(size * feePerShare(price, s));
}

/** Maker fee-equivalent for a filled maker order; the per-market daily rebate is split pro rata on this. */
export function makerFeeEquivalent(size: number, price: number, s: FeeSchedule): number {
  return size * feePerShare(price, s);
}

/**
 * Estimated maker rebate: pool = rebateRate * Σ taker fees in the market, split by fee-equivalent.
 * Pass the market's total maker fee-equivalent (≈ Σ taker fees, since every match has both sides).
 */
export function makerRebateEst(ourFeeEq: number, totalFeeEq: number, totalTakerFees: number, s: FeeSchedule): number {
  if (totalFeeEq <= 0) return 0;
  return (ourFeeEq / totalFeeEq) * s.rebateRate * totalTakerFees;
}
