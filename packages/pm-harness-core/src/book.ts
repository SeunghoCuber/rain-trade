import type { Level, LevelChange, Side, Token } from "./events.ts";

// Polymarket publishes one unified book per market: UP bid at p ≡ DOWN ask at 1−p (VERIFIED.md §3).
// We store it once, from the UP side, and derive the DOWN view by mirroring.
// Prices are kept as integers in millionths so that p and 1−p mirror exactly.

const SCALE = 1_000_000;
const ONE = SCALE;
export const toKey = (price: number) => Math.round(price * SCALE);
export const fromKey = (key: number) => key / SCALE;
const SIZE_EPS = 1e-9;

export interface Quote {
  bid: number | null;
  bidSize: number;
  ask: number | null;
  askSize: number;
}

export class Book {
  /** UP bids / asks: price key → resting size */
  private readonly bids = new Map<number, number>();
  private readonly asks = new Map<number, number>();

  clear(): void {
    this.bids.clear();
    this.asks.clear();
  }

  /** Replace the whole book with a snapshot of one token's side of it. */
  applySnapshot(token: Token, bids: readonly Level[], asks: readonly Level[]): void {
    this.clear();
    for (const l of bids) this.setLevel(token, "BUY", l.price, l.size);
    for (const l of asks) this.setLevel(token, "SELL", l.price, l.size);
  }

  applyChange(c: LevelChange): void {
    this.setLevel(c.token, c.side, c.price, c.size);
  }

  /** Set the total resting size at a level of `token`'s book (0 removes it). */
  setLevel(token: Token, side: Side, price: number, size: number): void {
    // DOWN BUY @p == UP SELL @1−p
    const upSide: Side = token === "UP" ? side : side === "BUY" ? "SELL" : "BUY";
    const key = token === "UP" ? toKey(price) : ONE - toKey(price);
    const m = upSide === "BUY" ? this.bids : this.asks;
    if (size <= SIZE_EPS) m.delete(key);
    else m.set(key, size);
  }

  /**
   * Remove levels that the venue's reported best bid/ask (in `token` terms) says are gone: resting
   * liquidity consumed by a match is never sent as a level update, it only shows up as a worse best
   * price on the next change (VERIFIED.md §3). Matching always takes the best levels first, so every
   * level better than the reported best was consumed. Returns the number of levels removed.
   */
  pruneToReported(token: Token, reportedBid: number | null, reportedAsk: number | null): number {
    // translate to UP terms: DOWN bid ↔ UP ask at 1−p
    const upBid = token === "UP" ? reportedBid : reportedAsk === null ? null : fromKey(ONE - toKey(reportedAsk));
    const upAsk = token === "UP" ? reportedAsk : reportedBid === null ? null : fromKey(ONE - toKey(reportedBid));
    let removed = 0;
    // null = not reported (unknown): leave that side alone. The venue reports an empty side as 0 / 1.
    const bidLimit = upBid === null ? Infinity : toKey(upBid);
    const askLimit = upAsk === null ? -Infinity : toKey(upAsk);
    for (const k of [...this.bids.keys()]) {
      if (k > bidLimit) {
        this.bids.delete(k);
        removed++;
      }
    }
    for (const k of [...this.asks.keys()]) {
      if (k < askLimit) {
        this.asks.delete(k);
        removed++;
      }
    }
    return removed;
  }

  /** Resting size at `price` on `side` of `token`'s book. */
  sizeAt(token: Token, side: Side, price: number): number {
    const upSide: Side = token === "UP" ? side : side === "BUY" ? "SELL" : "BUY";
    const key = token === "UP" ? toKey(price) : ONE - toKey(price);
    return (upSide === "BUY" ? this.bids : this.asks).get(key) ?? 0;
  }

  /** Best bid/ask of `token`. */
  quote(token: Token = "UP"): Quote {
    let bidK = -1;
    let askK = Infinity;
    for (const k of this.bids.keys()) if (k > bidK) bidK = k;
    for (const k of this.asks.keys()) if (k < askK) askK = k;
    const up: Quote = {
      bid: bidK >= 0 ? fromKey(bidK) : null,
      bidSize: bidK >= 0 ? this.bids.get(bidK)! : 0,
      ask: askK !== Infinity ? fromKey(askK) : null,
      askSize: askK !== Infinity ? this.asks.get(askK)! : 0,
    };
    if (token === "UP") return up;
    return {
      bid: up.ask === null ? null : fromKey(ONE - askK),
      bidSize: up.askSize,
      ask: up.bid === null ? null : fromKey(ONE - bidK),
      askSize: up.bidSize,
    };
  }

  /** Levels of `token`'s book on `side`, best first. */
  levels(token: Token, side: Side): Level[] {
    const upSide: Side = token === "UP" ? side : side === "BUY" ? "SELL" : "BUY";
    const m = upSide === "BUY" ? this.bids : this.asks;
    const out = [...m].map(([k, size]) => ({ price: fromKey(token === "UP" ? k : ONE - k), size }));
    // best first: highest bid, lowest ask
    return out.sort((a, b) => (side === "BUY" ? b.price - a.price : a.price - b.price));
  }

  get depth(): { bids: number; asks: number } {
    return { bids: this.bids.size, asks: this.asks.size };
  }

  /**
   * Compare with a snapshot of `token`'s book: levels (both sides) whose size differs, including
   * levels present on only one side. `nearTop` counts those within `nearTopDist` of the snapshot's
   * best price on that side (where quotes and fills happen).
   */
  diffSnapshot(token: Token, bids: readonly Level[], asks: readonly Level[], nearTopDist = 0.05): { total: number; nearTop: number } {
    let total = 0;
    let nearTop = 0;
    for (const [side, levels] of [["BUY", bids], ["SELL", asks]] as const) {
      const want = new Map(levels.filter((l) => l.size > SIZE_EPS).map((l) => [toKey(l.price), l.size]));
      const have = new Map(this.levels(token, side).map((l) => [toKey(l.price), l.size]));
      const keys = [...want.keys()];
      const best = keys.length ? (side === "BUY" ? Math.max(...keys) : Math.min(...keys)) : null;
      const count = (k: number) => {
        total++;
        if (best === null || Math.abs(k - best) <= toKey(nearTopDist)) nearTop++;
      };
      for (const [k, s] of want) if (Math.abs((have.get(k) ?? 0) - s) > SIZE_EPS) count(k);
      for (const k of have.keys()) if (!want.has(k)) count(k);
    }
    return { total, nearTop };
  }

  /** Stable text digest of the full book, for determinism checks. */
  digest(): string {
    const side = (m: Map<number, number>) => [...m].sort((a, b) => a[0] - b[0]).map(([k, s]) => `${k}:${s}`).join(",");
    return `b[${side(this.bids)}]a[${side(this.asks)}]`;
  }
}
