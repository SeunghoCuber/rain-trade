import { chainlinkTwap, type ChainlinkTick, type Config, type MarketEvent } from "@rain/pm-harness-core";
import { normCdf } from "./math.ts";

// Fair value of UP for a BTC 15-minute market (PLAN.md §4.3, adapted to the verified payoff).
//
// The market settles on A_end ≥ A_start, where A_B is the mean of the 60 one-second Chainlink ticks
// in [B−62 s, B−3 s] (VERIFIED.md §2.1). A_start (= S0) is known once the window opens. For A_end,
// ticks already observed are fixed; each future tick is S_t·exp(σ·W) with driftless Brownian W.
// Using the arithmetic (normal) approximation, which is exact to ~1e-8 for these tiny moves:
//   E[A_end]   = (Σ observed + r·S_t) / n
//   Var[A_end] = S_t²·σ²·Σ_i Σ_j min(d_i, d_j) / n² + noise²
// where d_i = seconds from now until future tick i, and noise covers the RTDS-vs-official TWAP error.
// P(UP) = Φ((E[A_end] − S0) / sd). Far from expiry this reduces to the plain digital
// Φ(ln(S_t/S0)/(σ√τ_eff)) with τ_eff = time to the averaging window + ~1/3 of its length.

export interface FairValue {
  /** P(UP) */
  p: number;
  /** per-second log vol used */
  sigma: number;
  /** seconds to windowEnd */
  tau: number;
  /** current price estimate on the Chainlink level */
  s: number;
  s0: number;
  /** expected / sd of the closing TWAP */
  mean: number;
  sd: number;
}

const SEC = 1000;
const HIST_SEC = 300;

/** EWMA variance of 1-second log returns of a price series, averaged over several half-lives. */
export class VolEstimator {
  private readonly alphas: number[];
  private readonly vars: number[];
  private lastSec: number | null = null;
  private lastSecPrice: number | null = null;
  private curSec: number | null = null;
  private curPrice: number | null = null;
  samples = 0;

  constructor(halfLivesSec: readonly number[], initSigma: number) {
    this.alphas = halfLivesSec.map((h) => 1 - Math.pow(2, -1 / h));
    this.vars = halfLivesSec.map(() => initSigma * initSigma);
  }

  /** Feed a price observed at `ms`; the last price in each second is the 1 s sample. */
  update(ms: number, price: number): void {
    const sec = Math.floor(ms / SEC);
    if (this.curSec !== null && sec > this.curSec) this.closeSecond();
    this.curSec = sec;
    this.curPrice = price;
  }

  private closeSecond(): void {
    const sec = this.curSec!;
    const price = this.curPrice!;
    if (this.lastSec !== null && this.lastSecPrice !== null && sec > this.lastSec) {
      const dt = sec - this.lastSec;
      const r = Math.log(price / this.lastSecPrice);
      // a return over dt seconds carries dt seconds of variance: count it as dt per-second samples
      for (let i = 0; i < this.vars.length; i++) {
        const a = 1 - Math.pow(1 - this.alphas[i]!, dt);
        this.vars[i] = (1 - a) * this.vars[i]! + (a * r * r) / dt;
      }
      this.samples += dt;
    }
    this.lastSec = sec;
    this.lastSecPrice = price;
  }

  /** Per-second log vol. */
  sigma(): number {
    return Math.sqrt(this.vars.reduce((a, b) => a + b, 0) / this.vars.length);
  }
}

/** EWMA of ln(Chainlink / spot mid), matched on the Chainlink tick's own timestamp. */
export class BasisTracker {
  private readonly spotBySec = new Map<number, number>();
  private readonly alpha: number;
  private b: number | null = null;

  constructor(halfLifeSec: number) {
    this.alpha = 1 - Math.pow(2, -1 / halfLifeSec);
  }

  onSpot(ms: number, mid: number): void {
    const sec = Math.floor(ms / SEC);
    this.spotBySec.set(sec, mid);
    if (this.spotBySec.size > HIST_SEC * 2) {
      for (const k of this.spotBySec.keys()) if (k < sec - HIST_SEC) this.spotBySec.delete(k);
    }
  }

  /** Chainlink tick with timestamp `tickMs` (arrives ~1.5 s later). */
  onChainlink(tickMs: number, price: number): void {
    const sec = Math.floor(tickMs / SEC);
    // latest spot mid at or before the tick's second
    let mid: number | undefined;
    for (let s = sec; s > sec - 5 && mid === undefined; s--) mid = this.spotBySec.get(s);
    if (mid === undefined) return;
    const x = Math.log(price / mid);
    this.b = this.b === null ? x : (1 - this.alpha) * this.b + this.alpha * x;
  }

  get basis(): number | null {
    return this.b;
  }
}

interface MarketWindow {
  windowStart: number;
  windowEnd: number;
  s0: number | null;
  s0Final: boolean;
}

/**
 * Tracks spot, Chainlink, volatility and basis from the event stream and prices any open market.
 * Feed it every event (`onEvent`), then ask `fairValue(marketId, nowMs)`.
 */
export class FairValueEngine {
  private readonly cfg: Config;
  readonly vol: VolEstimator;
  readonly basis: BasisTracker;
  /** Chainlink ticks by whole-second timestamp (full accuracy when available) */
  private readonly ticks = new Map<number, number>();
  private readonly spot: Record<"binance" | "coinbase", { ms: number; mid: number } | null> = { binance: null, coinbase: null };
  private lastChainlink: { ms: number; price: number } | null = null;
  private readonly markets = new Map<string, MarketWindow>();
  private readonly symbol: string;
  private readonly winFrom: number;
  private readonly winTo: number;

  constructor(cfg: Config) {
    this.cfg = cfg;
    const f = cfg.fairValue;
    this.vol = new VolEstimator(f.volHalfLivesSec, f.initSigmaPerSec);
    this.basis = new BasisTracker(f.basisHalfLifeSec);
    this.symbol = `${cfg.market.coin}/usd`;
    this.winFrom = cfg.settlement.twapWindow.fromSec;
    this.winTo = cfg.settlement.twapWindow.toSec;
  }

  onEvent(ev: MarketEvent): void {
    const now = Number(ev.recvTs / 1_000_000n);
    switch (ev.kind) {
      case "spot": {
        if (ev.payload.type !== "bbo") return;
        const mid = (ev.payload.bid + ev.payload.ask) / 2;
        const src = ev.payload.source;
        this.spot[src] = { ms: now, mid };
        // one source drives vol + basis (Binance when fresh), so their mids never interleave
        if (src === this.primarySpotSource(now)) {
          this.vol.update(now, mid);
          this.basis.onSpot(ev.exchangeTs, mid);
        }
        return;
      }
      case "res_price": {
        if (ev.payload.symbol !== this.symbol) return;
        const price = ev.payload.scaled ? Number(BigInt(ev.payload.scaled) / 10n ** 10n) / 1e8 : ev.payload.price;
        if (ev.payload.scaled || !this.ticks.has(ev.exchangeTs)) this.ticks.set(ev.exchangeTs, price);
        if (!ev.payload.backfill) {
          if (!this.lastChainlink || ev.exchangeTs >= this.lastChainlink.ms) this.lastChainlink = { ms: ev.exchangeTs, price };
          this.basis.onChainlink(ev.exchangeTs, price);
        }
        if (this.ticks.size > 2 * HIST_SEC * 4) {
          for (const k of this.ticks.keys()) if (k < ev.exchangeTs - 4 * HIST_SEC * SEC) this.ticks.delete(k);
        }
        return;
      }
      case "market_open":
        if (!this.markets.has(ev.marketId!)) {
          this.markets.set(ev.marketId!, { windowStart: ev.payload.windowStart, windowEnd: ev.payload.windowEnd, s0: null, s0Final: false });
        }
        return;
    }
  }

  private primarySpotSource(nowMs: number): "binance" | "coinbase" | null {
    const stale = this.cfg.fairValue.spotStaleMs;
    for (const src of ["binance", "coinbase"] as const) {
      const s = this.spot[src];
      if (s && nowMs - s.ms <= stale) return src;
    }
    return null;
  }

  /** Current price on the Chainlink level. */
  currentPrice(nowMs: number): number | null {
    const cl = this.lastChainlink?.price ?? null;
    if (this.cfg.fairValue.spotInput === "res_price") return cl;
    const src = this.primarySpotSource(nowMs);
    const b = this.basis.basis;
    if (src && b !== null) return this.spot[src]!.mid * Math.exp(b);
    return cl;
  }

  private tickList(): ChainlinkTick[] {
    return [...this.ticks].map(([timestampMs, p]) => ({ timestampMs, scaled: BigInt(Math.round(p * 1e8)) * 10n ** 10n }));
  }

  /** S0 for a market, from our Chainlink TWAP; final once its window's last tick has had time to arrive. */
  s0(marketId: string, nowMs: number): number | null {
    const m = this.markets.get(marketId);
    if (!m) return null;
    if (m.s0Final) return m.s0;
    const endOfWindow = m.windowStart + this.winTo * SEC;
    if (nowMs < endOfWindow) return null;
    const r = chainlinkTwap(this.tickList(), m.windowStart, { fromSec: this.winFrom, toSec: this.winTo });
    if (!r) return null;
    m.s0 = r.price;
    // ticks arrive ~1.5 s late; after 5 s nothing more is coming
    m.s0Final = nowMs >= endOfWindow + 5 * SEC;
    return m.s0;
  }

  /** P(UP) for `marketId` at `nowMs`, or null before S0 is known / without a price. `sOverride` prices a hypothetical spot. */
  fairValue(marketId: string, nowMs: number, sOverride?: number): FairValue | null {
    const m = this.markets.get(marketId);
    if (!m) return null;
    const s0 = this.s0(marketId, nowMs);
    const s = sOverride ?? this.currentPrice(nowMs);
    if (s0 === null || s === null) return null;
    return priceClosingTwap({
      nowMs,
      s,
      s0,
      sigma: this.vol.sigma(),
      windowEnd: m.windowEnd,
      winFromSec: this.winFrom,
      winToSec: this.winTo,
      observed: (t) => this.ticks.get(t),
      noiseUsd: this.cfg.fairValue.twapNoiseUsd,
    });
  }
}

export interface ClosingTwapInput {
  nowMs: number;
  s: number;
  s0: number;
  sigma: number;
  windowEnd: number;
  winFromSec: number;
  winToSec: number;
  /** observed Chainlink tick at a whole-second timestamp, if any */
  observed: (tMs: number) => number | undefined;
  noiseUsd: number;
}

/** P(closing TWAP ≥ S0), see the file header. */
export function priceClosingTwap(x: ClosingTwapInput): FairValue {
  const n = x.winToSec - x.winFromSec + 1;
  let obsSum = 0;
  const offsets: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = x.windowEnd + (x.winFromSec + i) * SEC;
    const v = t <= x.nowMs ? x.observed(t) : undefined;
    if (v !== undefined) obsSum += v;
    else offsets.push(Math.max(0, (t - x.nowMs) / SEC));
  }
  const r = offsets.length;
  // Σ_i Σ_j min(d_i, d_j) for ascending d: Σ_k d_k·(2(r−k)−1), k = 1..r
  let minSum = 0;
  for (let k = 0; k < r; k++) minSum += offsets[k]! * (2 * (r - k) - 1);
  const mean = (obsSum + r * x.s) / n;
  const sd = Math.sqrt((x.s * x.s * x.sigma * x.sigma * minSum) / (n * n) + x.noiseUsd * x.noiseUsd);
  const p = sd > 0 ? normCdf((mean - x.s0) / sd) : mean >= x.s0 ? 1 : 0;
  return { p, sigma: x.sigma, tau: Math.max(0, (x.windowEnd - x.nowMs) / SEC), s: x.s, s0: x.s0, mean, sd };
}
