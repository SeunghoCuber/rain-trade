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

/** The market maker of PLAN.md §4.4. */
export class MarketMaker implements Strategy {
  readonly name = "mm";
  private readonly s: Config["strategy"];

  constructor(cfg: Config) {
    this.s = cfg.strategy;
  }

  quote(ctx: QuoteContext): DesiredQuotes | null {
    const s = this.s;
    if (ctx.spotJump) return null;
    if (ctx.nowMs < ctx.windowStart || ctx.nowMs > ctx.windowEnd - s.pullBeforeCloseSec * 1000) return null;
    const hs = s.halfSpread + s.volSpreadMult * ctx.fvVol;
    const skew = s.skewPerShare * ctx.inventory; // long UP → quotes shift down
    let bid: number | null = ctx.fv.p - hs - skew;
    let ask: number | null = ctx.fv.p + hs - skew;
    if (ctx.inventory >= s.maxInventory) bid = null; // don't add risk beyond the cap
    if (ctx.inventory <= -s.maxInventory) ask = null;
    return { ...sanitize(bid, ask, ctx), size: s.quoteSize };
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
