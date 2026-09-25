import { blockBootstrap, drawdown, mean, median, quantile, sd, skew, sum, tStat, type BootstrapResult } from "./stats.ts";

// Analytics over one backtest run (PLAN.md §7). Pure functions over the run's rows so they can be
// tested without files; `load.ts` reads them from data/runs/<runId>/.

export type Mode = "optimistic" | "base" | "pessimistic";

export interface FillIn {
  mode: Mode;
  marketId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  ts: number;
  secondsToClose: number;
  fvAtFill: number;
  inventoryBefore: number;
  duringCancelLatency: boolean;
  spotMove1sBp: number | null;
  outcome: 0 | 1 | null;
}

export interface MarketIn {
  mode: Mode;
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
  fills: number;
  cancelLatencyFills: number;
  maxAbsInventory: number;
  capitalUsed: number;
  quoteUptimePct: number;
  realizedVol: number;
  /** from market_health (true when unknown) */
  excluded: boolean;
  flags: string;
}

export interface FvPoint {
  ts: number;
  fv: number;
}

export interface SimStats {
  placedSize: number;
  filledSize: number;
}

export const MARKOUT_HORIZONS_S = [0.5, 1, 2, 5, 10, 30, 60, 120] as const;

/** FV at or before ts (step function over the 250 ms grid). */
export function fvLookup(series: readonly FvPoint[], ts: number): number | null {
  if (!series.length) return null;
  if (ts < series[0]!.ts) return series[0]!.fv;
  let lo = 0, hi = series.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (series[mid]!.ts <= ts) lo = mid;
    else hi = mid - 1;
  }
  return series[lo]!.fv;
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const hourOf = (ms: number) => new Date(ms).toISOString().slice(0, 13);

export interface MarkoutPoint {
  horizon: string;
  seconds: number | null;
  cents: number;
  lo95: number;
  hi95: number;
}

export interface Breakdown {
  dimension: string;
  bucket: string;
  fills: number;
  volume: number;
  /** settlement edge d·(Y − p), ¢/share */
  edgeCents: number;
  /** 5 s markout d·(FV_{t+5} − p), ¢/share */
  markout5Cents: number;
}

export interface ModeAnalysis {
  mode: Mode;
  markets: number;
  marketsTotal: number;
  excludedMarkets: number;
  fills: number;
  volume: number;
  netPnl: number;
  netPnlExRebates: number;
  pnl: { trading: number; spread: number; adverse: number; inventory: number; rebates: number; fees: number };
  edgeCents: number;
  edgeCentsExRebates: number;
  perMarket: { mean: number; median: number; sd: number; skew: number; p5: number; p95: number };
  hitRate: number;
  winLossRatio: number;
  sharpeDaily: number;
  maxDrawdown: number;
  maxDrawdownMarkets: number;
  recoverMarkets: number | null;
  fillRate: number | null;
  quoteUptimePct: number;
  toxicFillShare: number;
  cancelLatencyFillShare: number;
  meanAbsInventoryBeforeFill: number;
  maxAbsInventory: number;
  capitalUsed: number;
  tStat: number;
  /** PLAN.md §7.4 */
  bootstrap: { blockBy: "day" | "hour"; meanPnlPerMarket: BootstrapResult; edgeCents: BootstrapResult; edgeCentsExRebates: BootstrapResult };
  markouts: MarkoutPoint[];
  breakdowns: Breakdown[];
  /** one point per included market, time-ordered (V1, V4) */
  cumulative: { windowStart: number; slug: string; trading: number; spread: number; adverse: number; inventory: number; rebates: number; net: number; underwater: number }[];
  /** per-market net PnL (V3) */
  perMarketPnl: number[];
}

export interface AnalyzeInput {
  fills: FillIn[];
  markets: MarketIn[];
  fv: Map<string, FvPoint[]>;
  simStats?: Partial<Record<Mode, SimStats>>;
  draws?: number;
  /** inventory considered "flat" within ± this many shares */
  flatInventory?: number;
}

export function analyzeMode(mode: Mode, x: AnalyzeInput): ModeAnalysis {
  const draws = x.draws ?? 10_000;
  const allMarkets = x.markets.filter((m) => m.mode === mode);
  const markets = allMarkets.filter((m) => !m.excluded).sort((a, b) => a.windowStart - b.windowStart);
  const included = new Set(markets.map((m) => m.marketId));
  const fills = x.fills.filter((f) => f.mode === mode && included.has(f.marketId) && f.outcome !== null);
  const net = (m: MarketIn) => m.pnlTrading + m.rebateEst - m.fees;
  const netEx = (m: MarketIn) => m.pnlTrading - m.fees;
  const volume = sum(markets.map((m) => m.volumeFilled));
  const perMarketPnl = markets.map(net);

  // cumulative + drawdown (V1, V4)
  let c = { trading: 0, spread: 0, adverse: 0, inventory: 0, rebates: 0, net: 0 };
  const cumNet: number[] = [];
  const cumulative = markets.map((m) => {
    c = {
      trading: c.trading + m.pnlTrading,
      spread: c.spread + m.pnlSpread,
      adverse: c.adverse + m.pnlAdverse,
      inventory: c.inventory + m.pnlInventory,
      rebates: c.rebates + m.rebateEst,
      net: c.net + net(m),
    };
    cumNet.push(c.net);
    return { windowStart: m.windowStart, slug: m.slug, ...c, underwater: 0 };
  });
  const dd = drawdown(cumNet);
  cumulative.forEach((p, i) => (p.underwater = dd.underwater[i]!));

  // daily Sharpe
  const byDay = new Map<string, number>();
  for (const m of markets) byDay.set(dayOf(m.windowStart), (byDay.get(dayOf(m.windowStart)) ?? 0) + net(m));
  const daily = [...byDay.values()];
  // needs enough days to mean anything
  const sharpeDaily = daily.length >= 5 && sd(daily) > 0 ? (mean(daily) / sd(daily)) * Math.sqrt(365) : NaN;

  // bootstrap blocks: days, or hours while there are fewer than 5 days
  const blockBy: "day" | "hour" = byDay.size >= 5 ? "day" : "hour";
  const key = blockBy === "day" ? dayOf : hourOf;
  const blocksMap = new Map<string, MarketIn[]>();
  for (const m of markets) (blocksMap.get(key(m.windowStart)) ?? blocksMap.set(key(m.windowStart), []).get(key(m.windowStart))!).push(m);
  const blocks = [...blocksMap.values()];
  const edgeOf = (f: (m: MarketIn) => number) => (ms: MarketIn[]) => {
    const v = sum(ms.map((m) => m.volumeFilled));
    return v ? (100 * sum(ms.map(f))) / v : NaN;
  };

  // markouts: Σ d(FV_{t+h} − p) q / Σ q, with a block bootstrap CI over the same blocks
  const markoutAt = (seconds: number | null) => (fs: FillIn[]) => {
    let num = 0, den = 0;
    for (const f of fs) {
      const d = f.side === "BUY" ? 1 : -1;
      const ref = seconds === null ? f.outcome! : fvLookup(x.fv.get(f.marketId) ?? [], f.ts + seconds * 1000) ?? f.fvAtFill;
      num += d * (ref - f.price) * f.size;
      den += f.size;
    }
    return den ? (100 * num) / den : NaN;
  };
  const fillBlocks = new Map<string, FillIn[]>();
  const marketBlock = new Map(markets.map((m) => [m.marketId, key(m.windowStart)]));
  for (const f of fills) {
    const b = marketBlock.get(f.marketId)!;
    (fillBlocks.get(b) ?? fillBlocks.set(b, []).get(b)!).push(f);
  }
  const markouts: MarkoutPoint[] = [...MARKOUT_HORIZONS_S, null].map((h) => {
    const bs = blockBootstrap([...fillBlocks.values()], markoutAt(h), Math.min(draws, 2_000));
    return { horizon: h === null ? "settle" : `${h}s`, seconds: h, cents: bs.estimate, lo95: bs.lo95, hi95: bs.hi95 };
  });

  // breakdowns (PLAN.md §7.6)
  const flat = x.flatInventory ?? 50;
  const vols = markets.map((m) => m.realizedVol).filter(Number.isFinite).sort((a, b) => a - b);
  const t1 = quantile(vols, 1 / 3), t2 = quantile(vols, 2 / 3);
  const volOf = new Map(markets.map((m) => [m.marketId, m.realizedVol <= t1 ? "low" : m.realizedVol <= t2 ? "med" : "high"]));
  const dims: [string, (f: FillIn) => string][] = [
    ["minute", (f) => String(Math.min(14, Math.max(0, 14 - Math.floor(f.secondsToClose / 60))))],
    ["fvBucket", (f) => (Math.min(9, Math.max(0, Math.floor(f.fvAtFill * 10))) / 10).toFixed(1)],
    ["volTercile", (f) => volOf.get(f.marketId) ?? "?"],
    ["hourUtc", (f) => new Date(f.ts).toISOString().slice(11, 13)],
    ["side", (f) => f.side],
    ["inventory", (f) => (f.inventoryBefore > flat ? "long" : f.inventoryBefore < -flat ? "short" : "flat")],
  ];
  const breakdowns: Breakdown[] = [];
  for (const [dimension, bucketOf] of dims) {
    const groups = new Map<string, FillIn[]>();
    for (const f of fills) (groups.get(bucketOf(f)) ?? groups.set(bucketOf(f), []).get(bucketOf(f))!).push(f);
    const numeric = [...groups.keys()].every((k) => k !== "" && Number.isFinite(Number(k)));
    const order = (a: string, b: string) => (numeric ? Number(a) - Number(b) : a < b ? -1 : a > b ? 1 : 0);
    for (const [bucket, fs] of [...groups].sort((a, b) => order(a[0], b[0]))) {
      const v = sum(fs.map((f) => f.size));
      breakdowns.push({ dimension, bucket, fills: fs.length, volume: v, edgeCents: markoutAt(null)(fs), markout5Cents: markoutAt(5)(fs) });
    }
  }

  const wins = perMarketPnl.filter((p) => p > 0);
  const losses = perMarketPnl.filter((p) => p < 0);
  const ss = x.simStats?.[mode];
  const toxic = fills.filter((f) => {
    const d = f.side === "BUY" ? 1 : -1;
    return d * ((fvLookup(x.fv.get(f.marketId) ?? [], f.ts + 5000) ?? f.fvAtFill) - f.price) < 0;
  }).length;
  const s = (f: (m: MarketIn) => number) => sum(markets.map(f));

  return {
    mode,
    markets: markets.length,
    marketsTotal: allMarkets.length,
    excludedMarkets: allMarkets.length - markets.length,
    fills: fills.length,
    volume,
    netPnl: s(net),
    netPnlExRebates: s(netEx),
    pnl: { trading: s((m) => m.pnlTrading), spread: s((m) => m.pnlSpread), adverse: s((m) => m.pnlAdverse), inventory: s((m) => m.pnlInventory), rebates: s((m) => m.rebateEst), fees: s((m) => m.fees) },
    edgeCents: volume ? (100 * s(net)) / volume : NaN,
    edgeCentsExRebates: volume ? (100 * s(netEx)) / volume : NaN,
    perMarket: { mean: mean(perMarketPnl), median: median(perMarketPnl), sd: sd(perMarketPnl), skew: skew(perMarketPnl), p5: quantile(perMarketPnl, 0.05), p95: quantile(perMarketPnl, 0.95) },
    hitRate: markets.length ? wins.length / markets.length : NaN,
    winLossRatio: wins.length && losses.length ? mean(wins) / Math.abs(mean(losses)) : NaN,
    sharpeDaily,
    maxDrawdown: dd.maxDd,
    maxDrawdownMarkets: dd.maxDdSteps,
    recoverMarkets: dd.recoverSteps,
    fillRate: ss && ss.placedSize ? ss.filledSize / ss.placedSize : null,
    quoteUptimePct: mean(markets.map((m) => m.quoteUptimePct)),
    toxicFillShare: fills.length ? toxic / fills.length : NaN,
    cancelLatencyFillShare: fills.length ? fills.filter((f) => f.duringCancelLatency).length / fills.length : NaN,
    meanAbsInventoryBeforeFill: mean(fills.map((f) => Math.abs(f.inventoryBefore))),
    maxAbsInventory: Math.max(0, ...markets.map((m) => m.maxAbsInventory)),
    capitalUsed: Math.max(0, ...markets.map((m) => m.capitalUsed)),
    tStat: tStat(perMarketPnl),
    bootstrap: {
      blockBy,
      meanPnlPerMarket: blockBootstrap(blocks, (ms) => mean(ms.map(net)), draws),
      edgeCents: blockBootstrap(blocks, edgeOf(net), draws, 43),
      edgeCentsExRebates: blockBootstrap(blocks, edgeOf(netEx), draws, 44),
    },
    markouts,
    breakdowns,
    cumulative,
    perMarketPnl,
  };
}

export interface RunAnalysis {
  runId: string;
  createdAt: string;
  modes: ModeAnalysis[];
  /** V9: per fill, spot move in the prior second vs 5 s markout (¢), base mode, thinned */
  spotVsMarkout: { mode: Mode; spotMove1sBp: number; markout5Cents: number; side: "BUY" | "SELL" }[];
  /** V5: minute-in-window × FV bucket → edge ¢/share per mode */
  heatMinuteFv: { mode: Mode; minute: number; fvBucket: number; fills: number; edgeCents: number }[];
  /** V6: vol tercile × hour → PnL per market per mode */
  heatVolHour: { mode: Mode; volTercile: string; hour: number; markets: number; pnlPerMarket: number }[];
}

export function analyzeRun(runId: string, x: AnalyzeInput): RunAnalysis {
  const modes = (["optimistic", "base", "pessimistic"] as const).map((m) => analyzeMode(m, x));
  const includedByMode = new Map(modes.map((a) => [a.mode, new Set(x.markets.filter((m) => m.mode === a.mode && !m.excluded).map((m) => m.marketId))]));
  const spotVsMarkout: RunAnalysis["spotVsMarkout"] = [];
  const cellsMF = new Map<string, { num: number; den: number; n: number }>();
  for (const f of x.fills) {
    if (!includedByMode.get(f.mode)?.has(f.marketId) || f.outcome === null) continue;
    const d = f.side === "BUY" ? 1 : -1;
    const fv5 = fvLookup(x.fv.get(f.marketId) ?? [], f.ts + 5000) ?? f.fvAtFill;
    if (f.spotMove1sBp !== null && spotVsMarkout.length < 20_000) spotVsMarkout.push({ mode: f.mode, spotMove1sBp: f.spotMove1sBp, markout5Cents: 100 * d * (fv5 - f.price), side: f.side });
    const minute = Math.min(14, Math.max(0, 14 - Math.floor(f.secondsToClose / 60)));
    const fvb = Math.min(9, Math.max(0, Math.floor(f.fvAtFill * 10)));
    const k = `${f.mode}|${minute}|${fvb}`;
    const cell = cellsMF.get(k) ?? cellsMF.set(k, { num: 0, den: 0, n: 0 }).get(k)!;
    cell.num += d * (f.outcome - f.price) * f.size;
    cell.den += f.size;
    cell.n++;
  }
  const heatMinuteFv = [...cellsMF].map(([k, v]) => {
    const [mode, minute, fvb] = k.split("|");
    return { mode: mode as Mode, minute: Number(minute), fvBucket: Number(fvb) / 10, fills: v.n, edgeCents: v.den ? (100 * v.num) / v.den : NaN };
  });
  const heatVolHour: RunAnalysis["heatVolHour"] = [];
  for (const mode of ["optimistic", "base", "pessimistic"] as const) {
    const ms = x.markets.filter((m) => m.mode === mode && !m.excluded);
    const vols = ms.map((m) => m.realizedVol).filter(Number.isFinite).sort((a, b) => a - b);
    const t1 = quantile(vols, 1 / 3), t2 = quantile(vols, 2 / 3);
    const cells = new Map<string, number[]>();
    for (const m of ms) {
      const vt = m.realizedVol <= t1 ? "low" : m.realizedVol <= t2 ? "med" : "high";
      const k = `${vt}|${new Date(m.windowStart).getUTCHours()}`;
      (cells.get(k) ?? cells.set(k, []).get(k)!).push(m.pnlTrading + m.rebateEst - m.fees);
    }
    for (const [k, v] of cells) {
      const [vt, hour] = k.split("|");
      heatVolHour.push({ mode, volTercile: vt!, hour: Number(hour), markets: v.length, pnlPerMarket: mean(v) });
    }
  }
  return { runId, createdAt: new Date().toISOString(), modes, spotVsMarkout, heatMinuteFv, heatVolHour };
}
