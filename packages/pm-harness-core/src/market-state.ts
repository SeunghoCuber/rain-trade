import { Book } from "./book.ts";
import type { EventOf, MarketEvent, Token } from "./events.ts";

export interface MarketMeta {
  marketId: string;
  slug: string;
  windowStart: number;
  windowEnd: number;
  upTokenId: string;
  downTokenId: string;
}

export interface MarketState {
  meta: MarketMeta | null;
  book: Book;
  /** current minimum tick, per token (the venue shrinks it near 0.99/0.01) */
  tickSize: Record<Token, number>;
  /** true once a snapshot has arrived and no gap has happened since */
  synced: boolean;
  lastTrade: EventOf<"trade"> | null;
  closed: boolean;
  outcome: Token | null;
}

export interface BookCheckStats {
  /** snapshots compared against the reconstructed book (only while synced) */
  snapshotsChecked: number;
  /** of those, snapshots where at least one level differed */
  snapshotMismatches: number;
  /** total differing levels across mismatched snapshots */
  levelMismatches: number;
  /**
   * of those, levels within 5 ticks of best. The venue silently removes some resting orders deep in
   * the book (no level update is sent; the next snapshot shows it), so deep diffs are expected;
   * near-top diffs would mean the reconstruction is wrong where we quote.
   */
  nearTopMismatches: number;
  /** level changes whose reported best bid/ask we checked */
  bestChecked: number;
  /** after pruning: reported best is a level our book does not have (a real reconstruction error) */
  bestMismatches: number;
  /** levels removed because the reported best showed they were consumed by a match */
  levelsPruned: number;
  /** changes applied while not synced (before the first snapshot or after a gap) */
  unsyncedChanges: number;
  firstMismatch: string | null;
}

/**
 * Applies the event stream to per-market state: unified order book, tick size, lifecycle.
 * With `verify`, cross-checks the reconstruction against every snapshot and every reported best
 * bid/ask; that is the Phase 3 exit check and a permanent guard against feed-format changes.
 */
export class MarketStates {
  readonly markets = new Map<string, MarketState>();
  readonly checks: BookCheckStats = {
    snapshotsChecked: 0,
    snapshotMismatches: 0,
    levelMismatches: 0,
    nearTopMismatches: 0,
    bestChecked: 0,
    bestMismatches: 0,
    levelsPruned: 0,
    unsyncedChanges: 0,
    firstMismatch: null,
  };
  private readonly verify: boolean;
  private readonly defaultTick: number;

  constructor(opts: { verify?: boolean; defaultTick?: number } = {}) {
    this.verify = opts.verify ?? false;
    this.defaultTick = opts.defaultTick ?? 0.01;
  }

  get(marketId: string): MarketState {
    let s = this.markets.get(marketId);
    if (!s) {
      s = {
        meta: null,
        book: new Book(),
        tickSize: { UP: this.defaultTick, DOWN: this.defaultTick },
        synced: false,
        lastTrade: null,
        closed: false,
        outcome: null,
      };
      this.markets.set(marketId, s);
    }
    return s;
  }

  apply(ev: MarketEvent): void {
    if (!ev.marketId) return;
    const s = this.get(ev.marketId);
    switch (ev.kind) {
      case "market_open": {
        const p = ev.payload;
        // seeing a market registered again means the recorder restarted: book updates were missed
        // until its new subscription's snapshot
        if (s.meta) s.synced = false;
        s.meta = {
          marketId: ev.marketId,
          slug: p.slug,
          windowStart: p.windowStart,
          windowEnd: p.windowEnd,
          upTokenId: p.upTokenId,
          downTokenId: p.downTokenId,
        };
        s.tickSize = { UP: p.tickSize, DOWN: p.tickSize };
        break;
      }
      case "book_snapshot": {
        const token = ev.token ?? "UP";
        if (this.verify && s.synced) {
          this.checks.snapshotsChecked++;
          const diff = s.book.diffSnapshot(token, ev.payload.bids, ev.payload.asks);
          if (diff.total) {
            this.checks.snapshotMismatches++;
            this.checks.levelMismatches += diff.total;
            this.checks.nearTopMismatches += diff.nearTop;
            if (diff.nearTop) this.checks.firstMismatch ??= `${ev.marketId} snapshot @${ev.recvTs}: ${diff.nearTop} levels near top differ`;
          }
        }
        s.book.applySnapshot(token, ev.payload.bids, ev.payload.asks);
        s.synced = true;
        break;
      }
      case "book_delta":
        for (const c of ev.payload.changes) {
          s.book.applyChange(c);
          if (!s.synced) {
            this.checks.unsyncedChanges++;
            continue;
          }
          this.checks.levelsPruned += s.book.pruneToReported(c.token, c.bestBid, c.bestAsk);
          if (this.verify) {
            this.checks.bestChecked++;
            const q = s.book.quote(c.token);
            const same = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) < 1e-9);
            // the venue reports an empty side as bid 0 / ask 1, not as missing
            const repBid = c.bestBid !== null && c.bestBid <= 0 ? null : c.bestBid;
            const repAsk = c.bestAsk !== null && c.bestAsk >= 1 ? null : c.bestAsk;
            if (!same(q.bid, repBid) || !same(q.ask, repAsk)) {
              this.checks.bestMismatches++;
              this.checks.firstMismatch ??= `${ev.marketId} delta @${ev.recvTs} ${c.token}: book ${q.bid}/${q.ask} vs reported ${c.bestBid}/${c.bestAsk}`;
            }
          }
        }
        break;
      case "trade":
        s.lastTrade = ev;
        break;
      case "tick_size_change":
        s.tickSize[ev.token ?? "UP"] = ev.payload.newTickSize;
        break;
      case "feed_gap":
        // deltas may have been missed; trust the book again only after the next snapshot
        s.synced = false;
        break;
      case "market_close":
        s.closed = true;
        break;
      case "resolution":
        s.outcome = ev.payload.outcome;
        break;
    }
  }
}
