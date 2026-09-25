import { FillMode as FillModeSchema, MarketStates, type Clock, type Config, type FillMode, type MarketEvent, type Side, type Token } from "@rain/pm-harness-core";
import { FillSim, Ledger, type FillInfo, type SimOrderState } from "@rain/pm-harness-sim";
import { FairValueEngine, type FairValue } from "./fair-value.ts";
import type { DesiredQuotes, Strategy } from "./strategy.ts";

// One engine for backtests and (later) live paper trading: feed it the ordered event stream through
// a Clock. Per fill mode it runs its own strategy instance, fill simulator and ledgers, so each mode
// sees the consequences of its own fills (PLAN.md §4.5: all three modes simultaneously).

export const FV_SAMPLE_MS = 250;
export const ADVERSE_HORIZON_MS = 5_000;

export interface FillRow {
  mode: FillMode;
  fillId: string;
  orderId: string;
  marketId: string;
  side: Side;
  price: number;
  size: number;
  ts: number;
  secondsToClose: number;
  fvAtFill: number;
  sigmaAtFill: number;
  inventoryBefore: number;
  duringCancelLatency: boolean;
  through: boolean;
  queueAheadAtLive: number | null;
  /** signed spot move over the previous second, bp */
  spotMove1sBp: number | null;
  bookBid: number | null;
  bookAsk: number | null;
  /** filled at settlement */
  fvH5: number | null;
  outcome: 0 | 1 | null;
}

export interface MarketResultRow {
  mode: FillMode;
  marketId: string;
  slug: string;
  windowStart: number;
  outcome: 0 | 1;
  pnlTrading: number;
  pnlSpread: number;
  pnlAdverse: number;
  pnlInventory: number;
  rebateEst: number;
  fees: number;
  volumeFilled: number;
  buyVolume: number;
  sellVolume: number;
  fills: number;
  cancelLatencyFills: number;
  maxAbsInventory: number;
  capitalUsed: number;
  quoteUptimePct: number;
  realizedVol: number;
  /** |pnlTrading − (spread + adverse + inventory)|: must be ~0 (sanity check 1) */
  decompError: number;
}

export interface FvRow {
  marketId: string;
  ts: number;
  fv: number;
  s: number;
  s0: number;
  sigma: number;
  mid: number | null;
}

export interface QuoteRow {
  mode: FillMode;
  marketId: string;
  ts: number;
  bid: number | null;
  ask: number | null;
  fv: number;
  inventory: number;
  /** quoteSize / displayed size at our bid/ask level (size-impact check, sanity 6) */
  bidImpact: number | null;
  askImpact: number | null;
}

interface ModeState {
  mode: FillMode;
  strategy: Strategy;
  sim: FillSim;
  ledgers: Map<string, Ledger>;
  fills: Map<string, FillRow[]>;
  lastQuote: Map<string, string>;
  pausedUntil: number;
  eligibleSamples: Map<string, number>;
  bothLiveSamples: Map<string, number>;
  cancelLatencyFills: Map<string, number>;
}

export interface RunnerOptions {
  cfg: Config;
  clock: Clock;
  /** a fresh strategy per mode */
  strategy: (mode: FillMode) => Strategy;
  modes?: readonly FillMode[];
  /** replace FV for quoting (perfect-foresight sanity check); results still use the real FV */
  quoteFv?: (marketId: string, nowMs: number, fv: FairValue) => FairValue;
}

export class BacktestRunner {
  readonly states = new MarketStates();
  readonly fvEng: FairValueEngine;
  readonly modes: ModeState[];
  readonly fvSeries = new Map<string, FvRow[]>();
  readonly quotes: QuoteRow[] = [];
  readonly results: MarketResultRow[] = [];
  private readonly cfg: Config;
  private readonly clock: Clock;
  private readonly quoteFv: RunnerOptions["quoteFv"];
  private readonly nextFvSample = new Map<string, number>();
  private readonly spotHist: { ms: number; mid: number }[] = [];
  private lastJumpMs = -Infinity;
  private fillSeq = 0;
  events = 0;

  constructor(o: RunnerOptions) {
    this.cfg = o.cfg;
    this.clock = o.clock;
    this.quoteFv = o.quoteFv;
    this.fvEng = new FairValueEngine(o.cfg);
    this.modes = (o.modes ?? FillModeSchema.options).map((mode) => {
      const st: ModeState = {
        mode,
        strategy: o.strategy(mode),
        sim: null as unknown as FillSim,
        ledgers: new Map(),
        fills: new Map(),
        lastQuote: new Map(),
        pausedUntil: 0,
        eligibleSamples: new Map(),
        bothLiveSamples: new Map(),
        cancelLatencyFills: new Map(),
      };
      st.sim = new FillSim({
        mode,
        params: o.cfg.sim.modes[mode],
        clock: o.clock,
        states: this.states,
        complementaryMatching: o.cfg.venue.complementaryMatching,
        onFill: (f) => this.onFill(st, f),
      });
      return st;
    });
  }

  private nowMs(): number {
    return Number(this.clock.now() / 1_000_000n);
  }

  private ledger(st: ModeState, marketId: string): Ledger {
    let l = st.ledgers.get(marketId);
    if (!l) {
      l = new Ledger({ mergePairs: this.cfg.settlement.mergePairs, fees: this.cfg.venue.feeSchedule });
      st.ledgers.set(marketId, l);
    }
    return l;
  }

  handle(ev: MarketEvent): void {
    this.events++;
    this.fvEng.onEvent(ev);
    for (const st of this.modes) st.sim.onEvent(ev); // before the book update: compares with known level sizes
    this.states.apply(ev);
    const now = this.nowMs();

    if (ev.kind === "spot" && ev.payload.type === "bbo") this.onSpot(now, (ev.payload.bid + ev.payload.ask) / 2);
    if (ev.kind === "resolution") this.settle(ev.marketId!, ev.payload.outcome);

    // markets to (re)quote: the event's market, or every open market on price-moving global events
    const targets = ev.marketId ? [ev.marketId] : ev.kind === "spot" || ev.kind === "res_price" ? [...this.states.markets.keys()] : [];
    for (const id of targets) this.evaluate(id, now);
  }

  private onSpot(now: number, mid: number): void {
    const h = this.spotHist;
    h.push({ ms: now, mid });
    const horizon = Math.max(this.cfg.strategy.pullOnSpotJump.windowMs, 1000);
    while (h.length && h[0]!.ms < now - horizon) h.shift();
    const jw = this.cfg.strategy.pullOnSpotJump;
    let lo = Infinity, hi = -Infinity;
    for (let i = h.length - 1; i >= 0 && h[i]!.ms >= now - jw.windowMs; i--) {
      lo = Math.min(lo, h[i]!.mid);
      hi = Math.max(hi, h[i]!.mid);
    }
    if (hi > 0 && lo > 0 && Math.log(hi / lo) * 1e4 > jw.bp) this.lastJumpMs = now;
  }

  private spotMove1sBp(now: number): number | null {
    const h = this.spotHist;
    if (!h.length) return null;
    let past: number | null = null;
    for (const x of h) if (x.ms <= now - 1000) past = x.mid;
    if (past === null) past = h[0]!.mid;
    return Math.log(h[h.length - 1]!.mid / past) * 1e4;
  }

  private fvVol(marketId: string, now: number, fv: FairValue): number {
    const bump = fv.s * Math.exp(fv.sigma * Math.sqrt(this.cfg.strategy.volHorizonSec));
    const up = this.fvEng.fairValue(marketId, now, bump);
    return up ? Math.abs(up.p - fv.p) : 0;
  }

  private evaluate(marketId: string, now: number): void {
    const s = this.states.get(marketId);
    const m = s.meta;
    if (!m || s.closed || now < m.windowStart || now >= m.windowEnd) return;
    const fv = this.fvEng.fairValue(marketId, now);
    if (!fv) return;
    const book = s.book.quote("UP");

    // FV series on a fixed grid (markouts, calibration, drill-down)
    const next = this.nextFvSample.get(marketId) ?? m.windowStart;
    if (now >= next) {
      const series = this.fvSeries.get(marketId) ?? this.fvSeries.set(marketId, []).get(marketId)!;
      series.push({ marketId, ts: now, fv: fv.p, s: fv.s, s0: fv.s0, sigma: fv.sigma, mid: book.bid !== null && book.ask !== null ? (book.bid + book.ask) / 2 : null });
      this.nextFvSample.set(marketId, next + Math.ceil((now - next + 1) / FV_SAMPLE_MS) * FV_SAMPLE_MS);
      for (const st of this.modes) this.sampleUptime(st, marketId, now, m.windowEnd);
    }
    if (!s.synced) {
      for (const st of this.modes) st.sim.cancelAll(marketId);
      return;
    }
    const jump = now - this.lastJumpMs < this.cfg.strategy.jumpCooldownMs;
    const fvVol = this.fvVol(marketId, now, fv);
    for (const st of this.modes) {
      const inv = this.ledger(st, marketId).inventory;
      const qfv = this.quoteFv ? this.quoteFv(marketId, now, fv) : fv;
      const want = st.strategy.quote({
        marketId,
        nowMs: now,
        windowStart: m.windowStart,
        windowEnd: m.windowEnd,
        fv: qfv,
        fvVol,
        book,
        inventory: inv,
        tickSize: s.tickSize.UP,
        spotJump: jump,
      });
      this.reconcile(st, marketId, want, now, fv, inv, s.book);
    }
  }

  private sampleUptime(st: ModeState, marketId: string, now: number, windowEnd: number): void {
    if (now > windowEnd - this.cfg.strategy.pullBeforeCloseSec * 1000) return;
    st.eligibleSamples.set(marketId, (st.eligibleSamples.get(marketId) ?? 0) + 1);
    const open = st.sim.openOrders(marketId);
    const live = (side: Side) => open.some((o) => o.side === side && (o.status === "Live" || o.status === "PartiallyFilled"));
    if (live("BUY") && live("SELL")) st.bothLiveSamples.set(marketId, (st.bothLiveSamples.get(marketId) ?? 0) + 1);
  }

  private reconcile(st: ModeState, marketId: string, want: DesiredQuotes | null, now: number, fv: FairValue, inv: number, book: { sizeAt: (t: Token, s: Side, p: number) => number }): void {
    const open = st.sim.openOrders(marketId).filter((o) => o.cancelReqNs === null);
    const thr = this.cfg.strategy.requoteThreshold;
    const size = want?.size ?? 0;
    for (const side of ["BUY", "SELL"] as const) {
      const target = want ? (side === "BUY" ? want.bid : want.ask) : null;
      const mine = open.filter((o) => o.side === side);
      let keep: SimOrderState | null = null;
      for (const o of mine) {
        if (target !== null && keep === null && Math.abs(o.price - target) < thr + 1e-9) keep = o;
        else st.sim.cancel(o);
      }
      if (target !== null && keep === null && size > 0) st.sim.place(marketId, side, target, size);
    }
    const key = `${want?.bid ?? ""}|${want?.ask ?? ""}`;
    if (st.lastQuote.get(marketId) !== key) {
      st.lastQuote.set(marketId, key);
      const impact = (side: Side, p: number | null) => {
        if (p === null || !want) return null;
        const shown = book.sizeAt("UP", side, p);
        return shown > 0 ? want.size / shown : null;
      };
      this.quotes.push({ mode: st.mode, marketId, ts: now, bid: want?.bid ?? null, ask: want?.ask ?? null, fv: fv.p, inventory: inv, bidImpact: impact("BUY", want?.bid ?? null), askImpact: impact("SELL", want?.ask ?? null) });
    }
  }

  private onFill(st: ModeState, f: FillInfo): void {
    const now = this.nowMs();
    const o = f.order;
    const s = this.states.get(o.marketId);
    const fv = this.fvEng.fairValue(o.marketId, now);
    const led = this.ledger(st, o.marketId);
    const inventoryBefore = led.inventory;
    led.applyFill(o.side, f.price, f.size);
    if (f.duringCancelLatency) st.cancelLatencyFills.set(o.marketId, (st.cancelLatencyFills.get(o.marketId) ?? 0) + 1);
    const q = s.book.quote("UP");
    const row: FillRow = {
      mode: st.mode,
      fillId: `${st.mode[0]}f${++this.fillSeq}`,
      orderId: o.orderId,
      marketId: o.marketId,
      side: o.side,
      price: f.price,
      size: f.size,
      ts: now,
      secondsToClose: s.meta ? (s.meta.windowEnd - now) / 1000 : NaN,
      fvAtFill: fv?.p ?? NaN,
      sigmaAtFill: fv?.sigma ?? NaN,
      inventoryBefore,
      duringCancelLatency: f.duringCancelLatency,
      through: f.through,
      queueAheadAtLive: o.queueAheadAtLive,
      spotMove1sBp: this.spotMove1sBp(now),
      bookBid: q.bid,
      bookAsk: q.ask,
      fvH5: null,
      outcome: null,
    };
    (st.fills.get(o.marketId) ?? st.fills.set(o.marketId, []).get(o.marketId)!).push(row);
  }

  /** FV at or before `ts` on the sampled grid (step function); the last sample after the window closes. */
  fvAt(marketId: string, ts: number): number | null {
    const xs = this.fvSeries.get(marketId);
    if (!xs?.length) return null;
    let lo = 0, hi = xs.length - 1;
    if (ts < xs[0]!.ts) return xs[0]!.fv;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (xs[mid]!.ts <= ts) lo = mid;
      else hi = mid - 1;
    }
    return xs[lo]!.fv;
  }

  private settle(marketId: string, outcome: Token): void {
    const s = this.states.get(marketId);
    const m = s.meta;
    if (!m) return;
    const y: 0 | 1 = outcome === "UP" ? 1 : 0;
    const series = this.fvSeries.get(marketId) ?? [];
    const realizedVol = series.length ? series[series.length - 1]!.sigma : NaN;
    for (const st of this.modes) {
      if (st.ledgers.get(marketId)?.settled) continue; // duplicate resolution events after restarts
      const led = this.ledger(st, marketId);
      const fills = st.fills.get(marketId) ?? [];
      let spread = 0, adverse = 0, inventory = 0, buy = 0, sell = 0;
      for (const f of fills) {
        const d = f.side === "BUY" ? 1 : -1;
        const fvT = Number.isFinite(f.fvAtFill) ? f.fvAtFill : f.price;
        const fvH = this.fvAt(marketId, f.ts + ADVERSE_HORIZON_MS) ?? fvT;
        f.fvH5 = fvH;
        f.outcome = y;
        spread += d * (fvT - f.price) * f.size;
        adverse += d * (fvH - fvT) * f.size;
        inventory += d * (y - fvH) * f.size;
        if (d > 0) buy += f.size;
        else sell += f.size;
      }
      const pnlTrading = led.settle(outcome);
      const eligible = st.eligibleSamples.get(marketId) ?? 0;
      this.results.push({
        mode: st.mode,
        marketId,
        slug: m.slug,
        windowStart: m.windowStart,
        outcome: y,
        pnlTrading,
        pnlSpread: spread,
        pnlAdverse: adverse,
        pnlInventory: inventory,
        rebateEst: led.rebateEstimate(),
        fees: 0,
        volumeFilled: led.volume,
        buyVolume: buy,
        sellVolume: sell,
        fills: fills.length,
        cancelLatencyFills: st.cancelLatencyFills.get(marketId) ?? 0,
        maxAbsInventory: led.maxAbsInventory,
        capitalUsed: -led.minCash,
        quoteUptimePct: eligible ? (100 * (st.bothLiveSamples.get(marketId) ?? 0)) / eligible : 0,
        realizedVol,
        decompError: Math.abs(pnlTrading - (spread + adverse + inventory)),
      });
    }
  }

  /** Drop everything held for a settled market (long-running live processes). */
  forget(marketId: string): void {
    this.fvSeries.delete(marketId);
    this.nextFvSample.delete(marketId);
    this.states.markets.delete(marketId);
    for (const st of this.modes) {
      st.ledgers.delete(marketId);
      st.fills.delete(marketId);
      st.lastQuote.delete(marketId);
      st.eligibleSamples.delete(marketId);
      st.bothLiveSamples.delete(marketId);
      st.cancelLatencyFills.delete(marketId);
    }
    for (let i = this.quotes.length - 1; i >= 0; i--) if (this.quotes[i]!.marketId === marketId) this.quotes.splice(i, 1);
  }

  /** Live view: net inventory per mode for a market. */
  inventory(marketId: string): Partial<Record<FillMode, number>> {
    return Object.fromEntries(this.modes.map((st) => [st.mode, st.ledgers.get(marketId)?.inventory ?? 0]));
  }

  allFills(): FillRow[] {
    return this.modes.flatMap((st) => [...st.fills.values()].flat());
  }

  allFv(): FvRow[] {
    return [...this.fvSeries.values()].flat();
  }
}
