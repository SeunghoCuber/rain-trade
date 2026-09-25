import type { FeeSchedule, Side, Token } from "@rain/pm-harness-core";
import { makerFeeEquivalent } from "./fees.ts";

// Positions and cash for one market (PLAN.md §4.6). Fills arrive in UP terms:
//   BUY  UP @p: pay p, receive UP.
//   SELL UP @p: sell UP we hold at p; beyond that it is a DOWN bid at 1−p, so pay 1−p and receive DOWN.
// With mergePairs, matched UP+DOWN pairs are redeemed for $1 immediately. Settlement pays
// UP·Y + DOWN·(1−Y). Economically every fill contributes d·(Y − p)·q, d = +1 buy / −1 sell.

export class Ledger {
  cash = 0;
  up = 0;
  down = 0;
  /** most negative cash reached: the capital this market needed */
  minCash = 0;
  volume = 0;
  maxAbsInventory = 0;
  /** Σ maker fee-equivalent of our fills; the rebate estimate is rebateRate × this (VERIFIED.md §4) */
  feeEquivalent = 0;
  merged = 0;
  settled: Token | null = null;
  private readonly mergePairs: boolean;
  private readonly fees: FeeSchedule;

  constructor(opts: { mergePairs: boolean; fees: FeeSchedule }) {
    this.mergePairs = opts.mergePairs;
    this.fees = opts.fees;
  }

  /** Net UP-equivalent shares (long UP = +, long DOWN = −). */
  get inventory(): number {
    return this.up - this.down;
  }

  applyFill(side: Side, price: number, size: number): void {
    if (side === "BUY") {
      this.cash -= price * size;
      this.up += size;
    } else {
      const fromUp = Math.min(this.up, size);
      this.cash += price * fromUp;
      this.up -= fromUp;
      const rest = size - fromUp;
      this.cash -= (1 - price) * rest;
      this.down += rest;
    }
    if (this.mergePairs) {
      const pairs = Math.min(this.up, this.down);
      if (pairs > 0) {
        this.up -= pairs;
        this.down -= pairs;
        this.cash += pairs;
        this.merged += pairs;
      }
    }
    this.volume += size;
    this.feeEquivalent += makerFeeEquivalent(size, price, this.fees);
    this.minCash = Math.min(this.minCash, this.cash);
    this.maxAbsInventory = Math.max(this.maxAbsInventory, Math.abs(this.inventory));
  }

  /** Pay out at resolution. Returns trading PnL (cash after settlement). */
  settle(outcome: Token): number {
    const y = outcome === "UP" ? 1 : 0;
    this.cash += this.up * y + this.down * (1 - y);
    this.up = 0;
    this.down = 0;
    this.settled = outcome;
    return this.cash;
  }

  rebateEstimate(): number {
    return this.fees.rebateRate * this.feeEquivalent;
  }
}
