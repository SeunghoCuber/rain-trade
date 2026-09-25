export type Mode = "optimistic" | "base" | "pessimistic";
export const MODES: Mode[] = ["optimistic", "base", "pessimistic"];

export interface RunInfo {
  runId: string;
  createdAt: string | null;
  strategy: string | null;
  events: number | null;
}

export interface Bootstrap {
  estimate: number;
  lo95: number;
  hi95: number;
  pPositive: number;
  draws: number;
  blocks: number;
  sample: number[];
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
  sharpeDaily: number | null;
  maxDrawdown: number;
  maxDrawdownMarkets: number;
  recoverMarkets: number | null;
  fillRate: number | null;
  quoteUptimePct: number;
  toxicFillShare: number;
  cancelLatencyFillShare: number;
  tStat: number | null;
  bootstrap: { blockBy: "day" | "hour"; meanPnlPerMarket: Bootstrap; edgeCents: Bootstrap; edgeCentsExRebates: Bootstrap };
  markouts: { horizon: string; seconds: number | null; cents: number | null; lo95: number | null; hi95: number | null }[];
  cumulative: { windowStart: number; slug: string; trading: number; spread: number; adverse: number; inventory: number; rebates: number; net: number; underwater: number }[];
  perMarketPnl: number[];
}

export interface RunAnalysis {
  runId: string;
  createdAt: string;
  modes: ModeAnalysis[];
  spotVsMarkout: { mode: Mode; spotMove1sBp: number; markout5Cents: number; side: "BUY" | "SELL" }[];
  heatMinuteFv: { mode: Mode; minute: number; fvBucket: number; fills: number; edgeCents: number | null }[];
  heatVolHour: { mode: Mode; volTercile: string; hour: number; markets: number; pnlPerMarket: number | null }[];
}

export interface MarketRow {
  market_id: string;
  slug: string;
  window_start: number;
  outcome: number;
  pnl: number;
  adverse: number;
  fills: number;
  volume: number;
  max_inv: number;
  uptime: number;
  flags: string;
  excluded: boolean;
}

export interface MarketDetail {
  meta: { slug: string; window_start: number; outcome: number; pnl: number } | null;
  fv: { ts: number; fv: number; mid: number | null }[];
  quotes: { ts: number; bid: number | null; ask: number | null; inventory: number }[];
  fills: { ts: number; side: "BUY" | "SELL"; price: number; size: number; markout5: number | null; inventoryAfter: number }[];
}

export interface Calibration {
  markets: number;
  bins: { panel: string; bucket: number; predicted: number; actual: number; n: number; source: "fv" | "mid" }[];
  note?: string;
}

export interface SweepMetrics {
  markets: number;
  volume: number;
  edgeCents: number | null;
  edgeCentsExRebates: number | null;
  meanPnl: number | null;
  tStat: number | null;
}

export interface Sweep {
  id: string;
  sweep: {
    sweepId: string;
    createdAt: string;
    mode: Mode;
    params: [string, (number | string | boolean)[]][];
    plateauAxes: string[];
    split: { by: string; boundaryMs: number; inSampleMarkets: number; outOfSampleMarkets: number };
    configsTried: number;
    configs: { id: string; overrides: Record<string, number | string | boolean>; is: SweepMetrics; oos: SweepMetrics }[];
    chosenId: string;
    plateau: { pass: boolean };
    oosRunId: string | null;
  };
  report: { verdict: "GO" | "NO-GO"; criteria: { name: string; threshold: string; value: string; pass: boolean }[] } | null;
}

export interface LiveStatus {
  updatedAt: string;
  stale: boolean;
  killSwitch: { halted: string | null; markets: number; cumulativePnl: number };
  markets: { slug: string; inWindow: boolean; secondsLeft: number; fairValue: number | null }[];
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

export const api = {
  runs: () => get<RunInfo[]>("/api/runs"),
  analysis: (run: string) => get<RunAnalysis>(`/api/runs/${encodeURIComponent(run)}/analysis`),
  markets: (run: string, mode: Mode) => get<MarketRow[]>(`/api/runs/${encodeURIComponent(run)}/markets?mode=${mode}`),
  market: (run: string, id: string, mode: Mode) => get<MarketDetail>(`/api/runs/${encodeURIComponent(run)}/markets/${encodeURIComponent(id)}?mode=${mode}`),
  calibration: () => get<Calibration>("/api/calibration"),
  latestSweep: () => get<Sweep | null>("/api/sweeps/latest"),
  liveStatus: () => get<LiveStatus | null>("/api/live/status"),
};
