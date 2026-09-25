import { useEffect, useState } from "react";
import { api, MODES, type Calibration, type MarketDetail, type MarketRow, type Mode, type RunAnalysis, type RunInfo, type Sweep } from "./api.ts";
import {
  BootstrapDist,
  CumulativePnl,
  Drawdown,
  HeatMinuteFv,
  HeatVolHour,
  MarketDrilldown,
  MarkoutCurve,
  ModeComparison,
  GoNoGo,
  PnlHistogram,
  Reliability,
  SpotVsMarkout,
  SweepHeatmap,
} from "./components/Charts.tsx";
import { MarketTable } from "./components/MarketTable.tsx";
import { fmt } from "./theme/chart.ts";

function Kpi({ label, value, sub, dir }: { label: string; value: string; sub?: string; dir?: number }) {
  const cls = dir === undefined || dir === 0 ? "" : dir > 0 ? "up" : "down";
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value num ${cls}`}>
        {cls && <span className="arrow">{dir! > 0 ? "▲" : "▼"}</span>}
        {value}
      </div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

export function App() {
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [run, setRun] = useState<string | null>(null);
  const params = new URLSearchParams(location.search);
  // PLAN.md: decisions are made on pessimistic fills; ?mode= / ?market= make views linkable
  const [mode, setMode] = useState<Mode>(MODES.includes(params.get("mode") as Mode) ? (params.get("mode") as Mode) : "pessimistic");
  const [a, setA] = useState<RunAnalysis | null>(null);
  const [markets, setMarkets] = useState<MarketRow[]>([]);
  const [selected, setSelected] = useState<string | null>(params.get("market"));
  const [detail, setDetail] = useState<MarketDetail | null>(null);
  const [cal, setCal] = useState<Calibration | null>(null);
  const [sweep, setSweep] = useState<Sweep | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.runs().then((r) => {
      setRuns(r);
      if (r[0]) setRun(r[0].runId);
    }, (e: Error) => setError(e.message));
    api.calibration().then(setCal, () => setCal(null));
    api.latestSweep().then(setSweep, () => setSweep(null));
  }, []);
  useEffect(() => {
    if (!run) return;
    setA(null);
    api.analysis(run).then(setA, (e: Error) => setError(e.message));
  }, [run]);
  useEffect(() => {
    if (!run) return;
    api.markets(run, mode).then(setMarkets, (e: Error) => setError(e.message));
  }, [run, mode]);
  useEffect(() => {
    if (!run || !selected) return setDetail(null);
    api.market(run, selected, mode).then(setDetail, (e: Error) => setError(e.message));
  }, [run, selected, mode]);

  const m = a?.modes.find((x) => x.mode === mode);
  const span = m?.cumulative.length ? `${fmt.time(m.cumulative[0]!.windowStart)} → ${fmt.time(m.cumulative[m.cumulative.length - 1]!.windowStart)} UTC` : "";

  return (
    <>
      <header className="topbar">
        <span className="brand">RainTrade</span>
        <div className="filters">
          <label className="chip">
            Run
            <select value={run ?? ""} onChange={(e) => (setRun(e.target.value), setSelected(null))}>
              {runs.map((r) => (
                <option key={r.runId} value={r.runId}>{r.runId}</option>
              ))}
            </select>
          </label>
          <label className="chip">
            Mode
            <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
              {MODES.map((x) => (
                <option key={x} value={x}>{x[0]!.toUpperCase() + x.slice(1)}</option>
              ))}
            </select>
          </label>
          <span className="chip static">Coin: BTC 15m</span>
        </div>
      </header>
      <main>
        {error && <div className="error">API error: {error}. Is `pnpm dashboard:api` running?</div>}
        {!runs.length && !error && <div className="empty">No backtest runs yet. Run `pnpm backtest --run-id mm-v1`.</div>}
        {m && a && (
          <>
            <div className="run-meta">
              {span} · {m.markets} usable of {m.marketsTotal} markets ({m.excludedMarkets} excluded) · {m.fills.toLocaleString()} fills · CI from {m.bootstrap.blockBy} blocks
              {m.markets < 2000 && <span className="warn-note"> · below the 2,000-market minimum sample: not a go/no-go result</span>}
            </div>
            <div className="kpis">
              <Kpi label="Net PnL" value={fmt.usd(m.netPnl)} sub={`ex rebates ${fmt.usd(m.netPnlExRebates)}`} dir={Math.sign(m.netPnl)} />
              <Kpi label="Edge ¢/share" value={fmt.cents(m.edgeCents, 3)} sub={`ex rebates ${fmt.cents(m.edgeCentsExRebates, 3)}`} dir={Math.sign(m.edgeCents)} />
              <Kpi label="95% CI (edge)" value={`[${fmt.num(m.bootstrap.edgeCents.lo95)}, ${fmt.num(m.bootstrap.edgeCents.hi95)}]`} sub={`P(edge > 0) ${fmt.num(m.bootstrap.edgeCents.pPositive, 3)}`} />
              <Kpi label="t-stat" value={fmt.num(m.tStat)} sub="needs ≥ 2.5" />
              <Kpi label="Max DD" value={fmt.usd(m.maxDrawdown)} sub={`${m.maxDrawdownMarkets} markets`} />
            </div>
            <CumulativePnl a={a} mode={mode} />
            <div className="grid-2">
              <MarkoutCurve a={a} />
              <PnlHistogram m={m} />
            </div>
            <div className="grid-2">
              <HeatMinuteFv a={a} mode={mode} />
              <Reliability cal={cal} />
            </div>
            <div className="grid-2">
              <SpotVsMarkout a={a} mode={mode} />
              <Drawdown m={m} />
            </div>
            <div className="grid-2">
              <ModeComparison a={a} />
              <BootstrapDist m={m} />
            </div>
            <div className="grid-2">
              <HeatVolHour a={a} mode={mode} />
              <SweepHeatmap s={sweep} />
            </div>
            <GoNoGo s={sweep} />
            <MarketTable rows={markets} selected={selected} onSelect={setSelected} />
            <MarketDrilldown d={detail} mode={mode} />
          </>
        )}
        {run && !a && !error && <div className="empty">Loading analysis…</div>}
      </main>
    </>
  );
}
