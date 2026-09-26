import { Rng, type Config, type Quote as BookQuote } from "@rain/pm-harness-core";
import type { FairValue } from "./fair-value.ts";

export interface QuoteContext {
  marketId: string;
  nowMs: number;
  windowStart: number;
  windowEnd: number;
  fv: FairValue;
  /** |FV(S·e^{σ√h}) − FV(S)|: how much FV moves on a one-sigma spot move over the vol horizon */
  fvVol: number;
  book: BookQuote;
  /** UP-equivalent shares */
  inventory: number;
  tickSize: number;
  /** a spot jump happened within the cooldown */
  spotJump: boolean;
  /** net taker volume in UP terms over the flow window: + = takers buying UP, − = selling */
  flowImbalance: number;
}

/** Desired resting quotes in UP terms; null side = no order; null result = pull everything. */
export interface DesiredQuotes {
  bid: number | null;
  ask: number | null;
  size: number;
}

export interface Strategy {
  readonly name: string;
  quote(ctx: QuoteContext): DesiredQuotes | null;
}

export const floorTick = (p: number, tick: number) => Math.floor(p / tick + 1e-9) * tick;
export const ceilTick = (p: number, tick: number) => Math.ceil(p / tick - 1e-9) * tick;
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** Keep quotes inside (0, 1), on the tick grid, and post-only (never at or through the other side). */
export function sanitize(bid: number | null, ask: number | null, ctx: QuoteContext): { bid: number | null; ask: number | null } {
  const t = ctx.tickSize;
  let b = bid === null ? null : floorTick(bid, t);
  let a = ask === null ? null : ceilTick(ask, t);
  if (b !== null && ctx.book.ask !== null) b = Math.min(b, floorTick(ctx.book.ask - t, t));
  if (a !== null && ctx.book.bid !== null) a = Math.max(a, ceilTick(ctx.book.bid + t, t));
  if (b !== null && (b < t - 1e-9 || b > 1 - t + 1e-9)) b = null;
  if (a !== null && (a < t - 1e-9 || a > 1 - t + 1e-9)) a = null;
  if (b !== null && a !== null && b >= a) return { bid: null, ask: null };
  return { bid: b === null ? null : round6(b), ask: a === null ? null : round6(a) };
}

/**
 * The market maker of PLAN.md §4.4, plus inventory control so it earns the spread instead of
 * carrying a position into settlement (where held shares are a coin flip):
 *  - the cap on |inventory| shrinks to 0 over the last `inventoryDecaySec` before the pull;
 *  - above the (shrinking) cap only the reducing side is quoted, at FV ± unwindEdge;
 *  - outside `fvBand` nothing is added, only reduced.
 */
export class MarketMaker implements Strategy {
  readonly name = "mm";
  private readonly s: Config["strategy"];

  constructor(cfg: Config) {
    this.s = cfg.strategy;
  }

  /** Inventory cap at `nowMs`: maxInventory, shrinking linearly to 0 at the pull. */
  cap(ctx: QuoteContext): number {
    const s = this.s;
    if (s.inventoryDecaySec <= 0) return s.maxInventory;
    const toPullSec = (ctx.windowEnd - s.pullBeforeCloseSec * 1000 - ctx.nowMs) / 1000;
    return s.maxInventory * Math.min(1, Math.max(0, toPullSec / s.inventoryDecaySec));
  }

  quote(ctx: QuoteContext): DesiredQuotes | null {
    const s = this.s;
    if (ctx.spotJump) return null;
    if (ctx.nowMs < ctx.windowStart || ctx.nowMs > ctx.windowEnd - s.pullBeforeCloseSec * 1000) return null;
    const inv = ctx.inventory;
    const cap = this.cap(ctx);
    // quoting fair value: optionally pulled toward the Polymarket mid (the market often knows more)
    const b = ctx.book;
    const mid = b.bid !== null && b.ask !== null && b.ask - b.bid <= s.midMaxSpread + 1e-9 ? (b.bid + b.ask) / 2 : null;
    const model = ctx.fv.p;
    const fv = mid === null ? model : (1 - s.fvMidWeight) * model + s.fvMidWeight * mid;
    const disagree = mid !== null && Math.abs(model - mid) > s.maxDisagreement;
    const hs = s.halfSpread + s.volSpreadMult * ctx.fvVol;
    const skew = s.skewPerShare * inv; // long UP → quotes shift down
    let bid: number | null = fv - hs - skew;
    let ask: number | null = fv + hs - skew;
    const extreme = fv < s.fvBand[0] || fv > s.fvBand[1];
    // never add beyond the (shrinking) cap, and never add when the outcome is nearly decided or when
    // our model and the market disagree strongly
    const noAdd = extreme || disagree;
    if (inv >= cap || (noAdd && inv >= 0)) bid = null;
    if (inv <= -cap || (noAdd && inv <= 0)) ask = null;
    // one-sided flow: takers selling UP would fill our bid (we'd buy into the move), so pull it unless it reduces a short
    if (s.flowImbalanceShares > 0) {
      if (ctx.flowImbalance <= -s.flowImbalanceShares && inv >= 0) bid = null;
      if (ctx.flowImbalance >= s.flowImbalanceShares && inv <= 0) ask = null;
    }
    // over the cap: work the reducing side at FV to get out (flat is the goal, not the spread)
    if (inv > cap && ask !== null) ask = Math.min(ask, fv + s.unwindEdge);
    if (inv < -cap && bid !== null) bid = Math.max(bid, fv - s.unwindEdge);
    // reducing quotes never need more than the position itself
    const size = inv > cap || inv < -cap ? Math.max(1, Math.min(s.quoteSize, Math.abs(inv))) : s.quoteSize;
    return { ...sanitize(bid, ask, ctx), size };
  }
}

/** Never quotes: must produce exactly zero PnL (sanity check 2). */
export class NoQuote implements Strategy {
  readonly name = "none";
  quote(): DesiredQuotes | null {
    return null;
  }
}

/**
 * Quotes at random distances (1–4 ticks) around the book mid, ignoring FV (sanity check 3). Targets
 * are re-drawn every `holdMs` from a seed derived from (market, time bucket), so results do not
 * depend on how often quote() is called.
 */
export class RandomQuote implements Strategy {
  readonly name = "random";
  private readonly size: number;
  private readonly seed: string;
  private readonly holdMs: number;

  constructor(cfg: Config, seed: string, holdMs = 5_000) {
    this.size = cfg.strategy.quoteSize;
    this.seed = seed;
    this.holdMs = holdMs;
  }

  quote(ctx: QuoteContext): DesiredQuotes | null {
    if (ctx.nowMs < ctx.windowStart || ctx.nowMs > ctx.windowEnd - 60_000) return null;
    if (ctx.book.bid === null || ctx.book.ask === null) return null;
    const rng = new Rng(`${this.seed}|${ctx.marketId}|${Math.floor(ctx.nowMs / this.holdMs)}`);
    const mid = (ctx.book.bid + ctx.book.ask) / 2;
    const t = ctx.tickSize;
    return { ...sanitize(mid - rng.int(1, 5) * t, mid + rng.int(1, 5) * t, ctx), size: this.size };
  }
}
