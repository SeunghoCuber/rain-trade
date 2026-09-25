import { chainlinkTwap, type ChainlinkTick, type Config, type MarketEvent, type Token } from "@rain/pm-harness-core";

// Per-market recording health. Coverage holes are measured from the data itself (inter-arrival
// times), so recorder restarts, crashes and machine sleep show up even though no feed_gap event
// could be written for them.

export type HealthFlag =
  | "OPEN" // window not finished yet; nothing else is judged
  | "NOCLOB" // registered but no book data
  | "LATE" // first book data > 5 s after window start
  | "GAP" // book/spot data hole inside the window > maxGapMs (Chainlink stalls are upstream, see CLTICKS)
  | "CLTICKS" // Chainlink coverage < 95% of the window's seconds (RTDS drops ~1% routinely)
  | "NORES" // no official resolution yet
  | "TWAPΔ" // our TWAP differs from Gamma's reference price by more than twapToleranceUsd
  | "SETTLE"; // our settlement outcome differs from the official one

/** Flags that remove a market from headline stats (PLAN.md §4.2, §9.5). */
export const EXCLUDING_FLAGS: readonly HealthFlag[] = ["NOCLOB", "LATE", "GAP", "NORES", "SETTLE"];

export interface MarketHealth {
  marketId: string;
  slug: string;
  windowStart: number;
  windowEnd: number;
  deltas: number;
  trades: number;
  snapshots: number;
  /** seconds from window start to first book event; null when there was none */
  lateSec: number | null;
  clobHoleMs: number;
  recHoleMs: number;
  feedGapMs: number;
  clTicks: number;
  s0: number | null;
  s0Ticks: number;
  s1: number | null;
  s1Ticks: number;
  ourOutcome: Token | null;
  outcome: Token | null;
  priceToBeat: number | null;
  finalPrice: number | null;
  s0Diff: number | null;
  s1Diff: number | null;
  flags: HealthFlag[];
  excluded: boolean;
}

interface Acc {
  marketId: string;
  slug: string;
  windowStart: number;
  windowEnd: number;
  firstClobMs: number | null;
  lastClobMs: number | null;
  clobHoleMs: number;
  maxClobGapMs: number;
  deltas: number;
  trades: number;
  snapshots: number;
  resolution: { outcome: Token; priceToBeat: number; finalPrice: number } | null;
}

export class HealthAccumulator {
  private readonly markets = new Map<string, Acc>();
  private readonly ticks = new Map<number, bigint>();
  /** spot-feed outages; RTDS gaps are excluded (upstream stalls, reflected in Chainlink tick coverage) */
  private readonly globalGaps: { endMs: number; gapMs: number }[] = [];
  /** gaps between consecutive events of any kind: the recorder itself was down (restart, crash, sleep) */
  private readonly recorderHoles: { start: number; end: number }[] = [];
  private lastEventMs: number | null = null;
  private readonly cfg: Config;
  readonly kinds: Partial<Record<MarketEvent["kind"], number>> = {};
  events = 0;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  add(ev: MarketEvent): void {
    this.events++;
    this.kinds[ev.kind] = (this.kinds[ev.kind] ?? 0) + 1;
    const t = Number(ev.recvTs / 1_000_000n);
    const m = ev.marketId ? this.markets.get(ev.marketId) : undefined;
    // backfill ticks and REST-driven events are stamped at arrival like everything else, so any
    // silence across all feeds > maxGapMs means nothing was being recorded
    if (this.lastEventMs !== null && t - this.lastEventMs > this.cfg.recorder.maxGapMs) {
      this.recorderHoles.push({ start: this.lastEventMs, end: t });
    }
    if (this.lastEventMs === null || t > this.lastEventMs) this.lastEventMs = t;
    switch (ev.kind) {
      case "market_open":
        if (!this.markets.has(ev.marketId!)) {
          this.markets.set(ev.marketId!, {
            marketId: ev.marketId!,
            slug: ev.payload.slug,
            windowStart: ev.payload.windowStart,
            windowEnd: ev.payload.windowEnd,
            firstClobMs: null,
            lastClobMs: null,
            clobHoleMs: 0,
            maxClobGapMs: 0,
            deltas: 0,
            trades: 0,
            snapshots: 0,
            resolution: null,
          });
        }
        break;
      case "book_delta":
      case "book_snapshot":
      case "trade": {
        if (!m) break;
        if (m.firstClobMs === null) m.firstClobMs = t;
        const from = Math.max(m.lastClobMs ?? m.windowStart, m.windowStart);
        const to = Math.min(t, m.windowEnd);
        if (to > from) m.clobHoleMs = Math.max(m.clobHoleMs, to - from);
        m.lastClobMs = t;
        if (ev.kind === "book_delta") m.deltas++;
        else if (ev.kind === "trade") m.trades++;
        else m.snapshots++;
        break;
      }
      case "feed_gap":
        if (m) m.maxClobGapMs = Math.max(m.maxClobGapMs, ev.payload.gapMs);
        else if (ev.payload.feed.startsWith("spot:")) this.globalGaps.push({ endMs: t, gapMs: ev.payload.gapMs });
        break;
      case "res_price": {
        const p = ev.payload;
        if (p.symbol !== `${this.cfg.market.coin}/usd`) break;
        // backfill ticks have no full-accuracy value; never let them override a live one
        if (p.scaled) this.ticks.set(ev.exchangeTs, BigInt(p.scaled));
        else if (!this.ticks.has(ev.exchangeTs)) this.ticks.set(ev.exchangeTs, BigInt(Math.round(p.price * 1e8)) * 10n ** 10n);
        break;
      }
      case "resolution":
        if (m) m.resolution = ev.payload;
        break;
    }
  }

  /** Markets whose window starts in [fromMs, toMs), judged as of `nowMs`. */
  finish(fromMs: number, toMs: number, nowMs: number): MarketHealth[] {
    const cfg = this.cfg;
    const tickList: ChainlinkTick[] = [...this.ticks].map(([timestampMs, scaled]) => ({ timestampMs, scaled }));
    const twapAt = (b: number) => chainlinkTwap(tickList, b, cfg.settlement.twapWindow);
    const winSec = cfg.market.durationSec;

    return [...this.markets.values()]
      .filter((m) => m.windowStart >= fromMs && m.windowStart < toMs)
      .sort((a, b) => a.windowStart - b.windowStart)
      .map((m): MarketHealth => {
        let clobHoleMs = m.clobHoleMs;
        // recording ended (or stalled) before windowEnd: count the tail as a hole once we know data went on
        const tailFrom = Math.max(m.lastClobMs ?? m.windowStart, m.windowStart);
        if (m.windowEnd > tailFrom && nowMs >= m.windowEnd) clobHoleMs = Math.max(clobHoleMs, m.windowEnd - tailFrom);
        const recHoleMs = Math.max(
          0,
          ...this.recorderHoles
            .filter((h) => h.end > m.windowStart && h.start < m.windowEnd)
            .map((h) => Math.min(h.end, m.windowEnd) - Math.max(h.start, m.windowStart)),
        );
        const feedGapMs = Math.max(
          m.maxClobGapMs,
          ...this.globalGaps.filter((g) => g.endMs > m.windowStart && g.endMs - g.gapMs < m.windowEnd).map((g) => g.gapMs),
        );
        let clTicks = 0;
        for (const ts of this.ticks.keys()) if (ts >= m.windowStart && ts < m.windowEnd) clTicks++;

        const s0 = twapAt(m.windowStart);
        const s1 = twapAt(m.windowEnd);
        const r = m.resolution;
        const ourOutcome: Token | null =
          s0 && s1 ? (s1.price > s0.price || (s1.price === s0.price && cfg.settlement.tieGoesTo === "up") ? "UP" : "DOWN") : null;
        const s0Diff = s0 && r ? s0.price - r.priceToBeat : null;
        const s1Diff = s1 && r ? s1.price - r.finalPrice : null;
        const lateSec = m.firstClobMs === null ? null : Math.max(0, (m.firstClobMs - m.windowStart) / 1000);

        const flags: HealthFlag[] = [];
        if (nowMs < m.windowEnd) flags.push("OPEN");
        else {
          if (lateSec === null) flags.push("NOCLOB");
          else if (lateSec > 5) flags.push("LATE");
          if (Math.max(clobHoleMs, recHoleMs, feedGapMs) > cfg.recorder.maxGapMs) flags.push("GAP");
          if (clTicks < 0.95 * winSec) flags.push("CLTICKS");
          if (!r) flags.push("NORES");
          const tol = cfg.settlement.twapToleranceUsd;
          if ((s0Diff !== null && Math.abs(s0Diff) > tol) || (s1Diff !== null && Math.abs(s1Diff) > tol)) flags.push("TWAPΔ");
          if (r && ourOutcome && ourOutcome !== r.outcome) flags.push("SETTLE");
        }
        return {
          marketId: m.marketId,
          slug: m.slug,
          windowStart: m.windowStart,
          windowEnd: m.windowEnd,
          deltas: m.deltas,
          trades: m.trades,
          snapshots: m.snapshots,
          lateSec,
          clobHoleMs,
          recHoleMs,
          feedGapMs,
          clTicks,
          s0: s0?.price ?? null,
          s0Ticks: s0?.count ?? 0,
          s1: s1?.price ?? null,
          s1Ticks: s1?.count ?? 0,
          ourOutcome,
          outcome: r?.outcome ?? null,
          priceToBeat: r?.priceToBeat ?? null,
          finalPrice: r?.finalPrice ?? null,
          s0Diff,
          s1Diff,
          flags,
          excluded: flags.includes("OPEN") || flags.some((f) => EXCLUDING_FLAGS.includes(f)),
        };
      });
  }
}
