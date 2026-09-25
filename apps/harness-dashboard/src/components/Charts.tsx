import { useState } from "react";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  ErrorBar,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { MODES, type Calibration, type MarketDetail, type Mode, type ModeAnalysis, type RunAnalysis, type Sweep } from "../api.ts";
import { axisProps, C, diverging, fmt, gridProps, MODE_COLOR, tooltipProps, tzName } from "../theme/chart.ts";
import { Empty, Panel } from "./Panel.tsx";

const H = 260;
const line = { strokeWidth: 2, dot: false, isAnimationActive: false } as const;
const MODE_LABEL: Record<Mode, string> = { optimistic: "Optimistic", base: "Base", pessimistic: "Pessimistic" };

/** V1: cumulative PnL by component for the selected mode, with the optimistic–pessimistic net band. */
export function CumulativePnl({ a, mode }: { a: RunAnalysis; mode: Mode }) {
  const m = a.modes.find((x) => x.mode === mode)!;
  const byMode = Object.fromEntries(a.modes.map((x) => [x.mode, x.cumulative])) as Record<Mode, ModeAnalysis["cumulative"]>;
  const data = m.cumulative.map((p, i) => {
    const nets = MODES.map((k) => byMode[k][i]?.net ?? p.net);
    return { ...p, band: [Math.min(...nets), Math.max(...nets)] as [number, number] };
  });
  const legend = [
    { label: "Net", color: C.inkStrong },
    { label: "Spread", color: C.slot[0]! },
    { label: "Adverse", color: C.slot[1]! },
    { label: "Inventory", color: C.slot[2]! },
    { label: "Rebates", color: C.slot[3]! },
    { label: "Mode range (net)", color: C.muted },
  ];
  return (
    <Panel
      id="V1"
      title="Cumulative PnL"
      question="Is it making money, and from what?"
      wide
      legend={legend}
      table={{ columns: ["market", "net $", "spread $", "adverse $", "inventory $", "rebates $"], rows: data.map((d) => [d.slug, d.net.toFixed(2), d.spread.toFixed(2), d.adverse.toFixed(2), d.inventory.toFixed(2), d.rebates.toFixed(2)]) }}
    >
      {data.length === 0 ? (
        <Empty>No usable markets in this run yet.</Empty>
      ) : (
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="windowStart" {...axisProps} tickFormatter={fmt.time} minTickGap={40} />
            <YAxis {...axisProps} tickFormatter={(v: number) => fmt.usd(v, 0)} width={64} />
            <Tooltip {...tooltipProps} labelFormatter={(v) => fmt.time(Number(v))} formatter={(v) => (Array.isArray(v) ? `${fmt.usd(v[0])} … ${fmt.usd(v[1])}` : fmt.usd(Number(v)))} />
            <ReferenceLine y={0} stroke={C.axis} />
            <Area dataKey="band" name="Mode range (net)" stroke="none" fill={C.muted} fillOpacity={0.18} isAnimationActive={false} />
            <Line dataKey="spread" name="Spread" stroke={C.slot[0]} {...line} />
            <Line dataKey="adverse" name="Adverse" stroke={C.slot[1]} {...line} />
            <Line dataKey="inventory" name="Inventory" stroke={C.slot[2]} {...line} />
            <Line dataKey="rebates" name="Rebates" stroke={C.slot[3]} {...line} />
            <Line dataKey="net" name="Net" stroke={C.inkStrong} {...line} strokeWidth={2.5} />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </Panel>
  );
}

/** V2: markout curve per fill mode with 95% CI bands. */
export function MarkoutCurve({ a }: { a: RunAnalysis }) {
  const horizons = a.modes[0]?.markouts.map((p) => p.horizon) ?? [];
  const data = horizons.map((h, i) => {
    const row: Record<string, unknown> = { horizon: h };
    for (const m of a.modes) {
      const p = m.markouts[i]!;
      row[m.mode] = p.cents;
      row[`${m.mode}Ci`] = p.lo95 !== null && p.hi95 !== null ? [p.lo95, p.hi95] : null;
    }
    return row;
  });
  return (
    <Panel
      id="V2"
      title="Markout curve"
      question="How fast am I being picked off?"
      legend={MODES.map((m) => ({ label: MODE_LABEL[m], color: MODE_COLOR[m] }))}
      table={{ columns: ["horizon", ...MODES.map((m) => `${m} ¢/sh`)], rows: data.map((d) => [String(d.horizon), ...MODES.map((m) => fmt.num(d[m] as number, 2))]) }}
    >
      <ResponsiveContainer width="100%" height={H}>
        <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="horizon" {...axisProps} />
          <YAxis {...axisProps} tickFormatter={(v: number) => `${v}¢`} width={48} />
          <Tooltip {...tooltipProps} formatter={(v) => (Array.isArray(v) ? `${fmt.cents(v[0])} … ${fmt.cents(v[1])}` : fmt.cents(Number(v)))} />
          <ReferenceLine y={0} stroke={C.axis} />
          {MODES.map((m) => (
            <Area key={`${m}Ci`} dataKey={`${m}Ci`} name={`${MODE_LABEL[m]} 95% CI`} stroke="none" fill={MODE_COLOR[m]} fillOpacity={0.12} isAnimationActive={false} />
          ))}
          {MODES.map((m) => (
            <Line key={m} dataKey={m} name={MODE_LABEL[m]} stroke={MODE_COLOR[m]} {...line} dot={{ r: 3, strokeWidth: 0, fill: MODE_COLOR[m] }} />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </Panel>
  );
}

function histogram(xs: number[], bins = 14): { x: number; lo: number; hi: number; n: number }[] {
  if (!xs.length) return [];
  const lo = Math.min(...xs), hi = Math.max(...xs);
  const w = (hi - lo) / bins || 1;
  const out = Array.from({ length: bins }, (_, i) => ({ x: lo + (i + 0.5) * w, lo: lo + i * w, hi: lo + (i + 1) * w, n: 0 }));
  for (const x of xs) out[Math.min(bins - 1, Math.floor((x - lo) / w))]!.n++;
  return out;
}

/** V3: per-market PnL histogram with mean, median and the bootstrap CI of the mean. */
export function PnlHistogram({ m }: { m: ModeAnalysis }) {
  const bins = histogram(m.perMarketPnl);
  const bs = m.bootstrap.meanPnlPerMarket;
  return (
    <Panel
      id="V3"
      title="Per-market PnL"
      question="Is the edge a few lucky markets or broad?"
      legend={[{ label: "Mean", color: C.inkStrong }, { label: "Median", color: C.muted, dashed: true }, { label: "95% CI of mean", color: C.slot[0]! }]}
      table={{ columns: ["from $", "to $", "markets"], rows: bins.map((b) => [b.lo.toFixed(1), b.hi.toFixed(1), b.n]) }}
    >
      {bins.length === 0 ? (
        <Empty>No usable markets.</Empty>
      ) : (
        <ResponsiveContainer width="100%" height={H}>
          <BarChart data={bins} margin={{ top: 8, right: 16, bottom: 0, left: 8 }} barCategoryGap={2}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="x" type="number" domain={["dataMin - 20", "dataMax + 20"]} {...axisProps} tickFormatter={(v: number) => fmt.usd(v, 0)} />
            <YAxis {...axisProps} allowDecimals={false} width={32} />
            <Tooltip {...tooltipProps} labelFormatter={(v) => `around ${fmt.usd(Number(v), 0)}`} formatter={(v) => [`${v} markets`, "count"]} />
            <Bar dataKey="n" fill={C.slot[0]} fillOpacity={0.55} radius={[4, 4, 0, 0]} isAnimationActive={false} />
            <ReferenceLine x={bs.lo95} stroke={C.slot[0]} strokeWidth={2} />
            <ReferenceLine x={bs.hi95} stroke={C.slot[0]} strokeWidth={2} />
            <ReferenceLine x={m.perMarket.median} stroke={C.muted} strokeDasharray="4 3" strokeWidth={2} />
            <ReferenceLine x={m.perMarket.mean} stroke={C.inkStrong} strokeWidth={2} />
            <ReferenceLine x={0} stroke={C.axis} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </Panel>
  );
}

/** V4: drawdown (underwater) chart. */
export function Drawdown({ m }: { m: ModeAnalysis }) {
  return (
    <Panel id="V4" title="Drawdown" question="How much pain before recovery?" table={{ columns: ["market", "underwater $"], rows: m.cumulative.map((c) => [c.slug, c.underwater.toFixed(2)]) }}>
      <ResponsiveContainer width="100%" height={H}>
        <ComposedChart data={m.cumulative} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="windowStart" {...axisProps} tickFormatter={fmt.time} minTickGap={40} />
          <YAxis {...axisProps} tickFormatter={(v: number) => fmt.usd(v, 0)} width={64} />
          <Tooltip {...tooltipProps} labelFormatter={(v) => fmt.time(Number(v))} formatter={(v) => [fmt.usd(Number(v)), "below peak"]} />
          <Area dataKey="underwater" stroke={C.down} strokeWidth={2} fill={C.down} fillOpacity={0.15} isAnimationActive={false} />
          <ReferenceLine y={0} stroke={C.axis} />
        </ComposedChart>
      </ResponsiveContainer>
    </Panel>
  );
}

function Heatmap({ rows, cols, cell, rowLabel, colLabel, unit }: { rows: string[]; cols: string[]; cell: (r: string, c: string) => { v: number | null; n: number }; rowLabel: string; colLabel: string; unit: (v: number) => string }) {
  const [hover, setHover] = useState<string | null>(null);
  const vals = rows.flatMap((r) => cols.map((c) => cell(r, c).v)).filter((v): v is number => v !== null && Number.isFinite(v));
  const max = Math.max(1e-9, ...vals.map(Math.abs));
  return (
    <div className="heatmap">
      <div className="heat-grid" style={{ gridTemplateColumns: `72px repeat(${cols.length}, minmax(14px, 1fr))` }}>
        <div className="heat-corner">{rowLabel}</div>
        {cols.map((c) => (
          <div key={c} className="heat-col num">{c}</div>
        ))}
        {rows.map((r) => [
          <div key={`${r}-l`} className="heat-row num">{r}</div>,
          ...cols.map((c) => {
            const { v, n } = cell(r, c);
            const text = v === null || !Number.isFinite(v) ? `${rowLabel} ${r}, ${colLabel} ${c}: no fills` : `${rowLabel} ${r}, ${colLabel} ${c}: ${unit(v)} (n=${n})`;
            return <div key={`${r}-${c}`} className="heat-cell" style={{ background: diverging(v, max) }} title={text} onMouseEnter={() => setHover(text)} onMouseLeave={() => setHover(null)} />;
          }),
        ])}
      </div>
      <div className="heat-foot">
        <span className="heat-readout num">{hover ?? `hover a cell · ${colLabel} →`}</span>
        <span className="heat-scale">
          <span className="num">{unit(-max)}</span>
          <span className="heat-ramp" style={{ background: `linear-gradient(90deg, ${C.divNeg}, ${C.divMid}, ${C.divPos})` }} />
          <span className="num">{unit(max)}</span>
        </span>
      </div>
    </div>
  );
}

/** V5: minute in window × FV bucket → edge ¢/share. */
export function HeatMinuteFv({ a, mode }: { a: RunAnalysis; mode: Mode }) {
  const cells = a.heatMinuteFv.filter((c) => c.mode === mode);
  const get = (r: string, c: string) => {
    const x = cells.find((k) => k.fvBucket.toFixed(1) === r && String(k.minute) === c);
    return { v: x?.edgeCents ?? null, n: x?.fills ?? 0 };
  };
  const rows = Array.from({ length: 10 }, (_, i) => (0.9 - i / 10).toFixed(1));
  const cols = Array.from({ length: 15 }, (_, i) => String(i));
  return (
    <Panel id="V5" title="Minute × FV heatmap" question="Where in the window and probability range do I lose?" table={{ columns: ["minute", "FV bucket", "fills", "edge ¢/sh"], rows: cells.map((c) => [c.minute, c.fvBucket.toFixed(1), c.fills, fmt.num(c.edgeCents, 2)]) }}>
      {cells.length ? <Heatmap rows={rows} cols={cols} cell={get} rowLabel="FV" colLabel="minute" unit={(v) => fmt.cents(v, 1)} /> : <Empty>No fills.</Empty>}
    </Panel>
  );
}

/** V6: vol tercile × hour of day (display time zone) → PnL per market. */
export function HeatVolHour({ a, mode }: { a: RunAnalysis; mode: Mode }) {
  const cells = a.heatVolHour.filter((c) => c.mode === mode);
  const get = (r: string, c: string) => {
    const x = cells.find((k) => k.volTercile === r && String(k.hour).padStart(2, "0") === c);
    return { v: x?.pnlPerMarket ?? null, n: x?.markets ?? 0 };
  };
  const cols = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
  return (
    <Panel id="V6" title="Vol × hour heatmap" question="Which regimes and sessions to avoid?" table={{ columns: ["vol tercile", `hour (${(a.timeZone ?? "UTC") === "UTC" ? "UTC" : tzName()})`, "markets", "PnL/market $"], rows: cells.map((c) => [c.volTercile, c.hour, c.markets, fmt.num(c.pnlPerMarket, 2)]) }}>
      {cells.length ? <Heatmap rows={["high", "med", "low"]} cols={cols} cell={get} rowLabel="vol" colLabel={`hour ${(a.timeZone ?? "UTC") === "UTC" ? "UTC" : tzName()}`} unit={(v) => fmt.usd(v, 0)} /> : <Empty>No markets.</Empty>}
    </Panel>
  );
}

/** V7: one market: FV, Polymarket mid, our quotes and fills; inventory in its own chart (no second axis). */
export function MarketDrilldown({ d, mode }: { d: MarketDetail | null; mode: Mode }) {
  if (!d?.meta) {
    return (
      <Panel id="V7" title="Market drill-down" question="What actually happened in this market?" wide>
        <Empty>Click a row in the market table.</Empty>
      </Panel>
    );
  }
  const good = d.fills.filter((f) => (f.markout5 ?? 0) >= 0);
  const toxic = d.fills.filter((f) => (f.markout5 ?? 0) < 0);
  const start = d.meta.window_start;
  const domain: [number, number] = [start, start + 900_000];
  const invSteps = [{ ts: start, inv: 0 }, ...d.fills.map((f) => ({ ts: f.ts, inv: f.inventoryAfter }))];
  const legend = [
    { label: "Fair value", color: C.slot[0]! },
    { label: "Polymarket mid", color: C.muted, dashed: true },
    { label: "Our bid", color: C.slot[2]! },
    { label: "Our ask", color: C.slot[1]! },
    { label: "Fill, good 5 s markout", color: C.up },
    { label: "Fill, toxic", color: C.down },
  ];
  return (
    <Panel
      id="V7"
      title={`Market drill-down · ${d.meta.slug} · ${MODE_LABEL[mode]}`}
      question={`Outcome ${d.meta.outcome ? "UP" : "DOWN"} · net ${fmt.usd(d.meta.pnl)} · ${d.fills.length} fills`}
      wide
      legend={legend}
      table={{ columns: ["time", "side", "price", "size", "5 s markout ¢", "inventory after"], rows: d.fills.map((f) => [fmt.clock(f.ts), f.side, f.price.toFixed(3), f.size.toFixed(0), fmt.num(f.markout5, 2), f.inventoryAfter.toFixed(0)]) }}
    >
      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="ts" type="number" domain={domain} {...axisProps} tickFormatter={fmt.clock} allowDuplicatedCategory={false} />
          <YAxis {...axisProps} domain={[0, 1]} tickFormatter={(v: number) => v.toFixed(2)} width={40} />
          <Tooltip {...tooltipProps} labelFormatter={(v) => fmt.clock(Number(v))} formatter={(v, n) => [typeof v === "number" ? v.toFixed(3) : String(v), n]} />
          <Line data={d.fv} dataKey="mid" name="Polymarket mid" stroke={C.muted} strokeDasharray="4 3" {...line} connectNulls />
          <Line data={d.fv} dataKey="fv" name="Fair value" stroke={C.slot[0]} {...line} />
          <Line data={d.quotes} dataKey="bid" name="Our bid" stroke={C.slot[2]} type="stepAfter" {...line} strokeWidth={1.5} />
          <Line data={d.quotes} dataKey="ask" name="Our ask" stroke={C.slot[1]} type="stepAfter" {...line} strokeWidth={1.5} />
          <Scatter data={good} dataKey="price" name="Fill, good" fill={C.up} stroke={C.surface} strokeWidth={2} shape="circle" isAnimationActive={false} />
          <Scatter data={toxic} dataKey="price" name="Fill, toxic" fill={C.down} stroke={C.surface} strokeWidth={2} shape="circle" isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
      <div className="subchart-label">Inventory (UP-equivalent shares)</div>
      <ResponsiveContainer width="100%" height={110}>
        <LineChart data={invSteps} margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="ts" type="number" domain={domain} {...axisProps} tickFormatter={fmt.clock} />
          <YAxis {...axisProps} width={40} />
          <Tooltip {...tooltipProps} labelFormatter={(v) => fmt.clock(Number(v))} formatter={(v) => [Number(v).toFixed(0), "inventory"]} />
          <ReferenceLine y={0} stroke={C.axis} />
          <Line dataKey="inv" type="stepAfter" stroke={C.inkStrong} {...line} />
        </LineChart>
      </ResponsiveContainer>
    </Panel>
  );
}

/** V8: reliability diagram, FV vs Polymarket mid, one panel per time-left bucket. */
export function Reliability({ cal }: { cal: Calibration | null }) {
  const panels = ["τ > 10 min", "5–10 min", "< 5 min"];
  return (
    <Panel
      id="V8"
      title="Reliability diagram"
      question={`Is fair value calibrated, and better than the market? (${cal?.markets ?? 0} resolved markets)`}
      legend={[{ label: "Our FV", color: C.slot[0]! }, { label: "Polymarket mid", color: C.slot[1]! }, { label: "Perfect calibration", color: C.axis, dashed: true }]}
      table={{ columns: ["panel", "source", "bucket", "predicted", "actual", "n"], rows: (cal?.bins ?? []).map((b) => [b.panel, b.source, b.bucket / 10, b.predicted.toFixed(3), b.actual.toFixed(3), b.n]) }}
    >
      {!cal?.bins.length ? (
        <Empty>{cal?.note ?? "No calibration samples yet."}</Empty>
      ) : (
        <div className="multiples">
          {panels.map((p) => (
            <div key={p}>
              <div className="subchart-label">{p}</div>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid {...gridProps} vertical />
                  <XAxis dataKey="predicted" type="number" domain={[0, 1]} {...axisProps} ticks={[0, 0.5, 1]} />
                  <YAxis dataKey="actual" type="number" domain={[0, 1]} {...axisProps} ticks={[0, 0.5, 1]} width={28} />
                  <Tooltip {...tooltipProps} formatter={(v) => Number(v).toFixed(3)} />
                  <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]} stroke={C.axis} strokeDasharray="4 3" />
                  <Line data={cal.bins.filter((b) => b.panel === p && b.source === "mid")} dataKey="actual" name="Polymarket mid" stroke={C.slot[1]} {...line} dot={{ r: 3, strokeWidth: 0, fill: C.slot[1] }} />
                  <Line data={cal.bins.filter((b) => b.panel === p && b.source === "fv")} dataKey="actual" name="Our FV" stroke={C.slot[0]} {...line} dot={{ r: 3, strokeWidth: 0, fill: C.slot[0] }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/** V9: spot move in the second before a fill vs its 5 s markout. */
export function SpotVsMarkout({ a, mode }: { a: RunAnalysis; mode: Mode }) {
  const pts = a.spotVsMarkout.filter((p) => p.mode === mode).slice(0, 4000);
  return (
    <Panel id="V9" title="Spot jump vs markout" question="Are toxic fills explained by spot jumps (→ fix pull logic)?" table={{ columns: ["spot move bp", "5 s markout ¢", "side"], rows: pts.slice(0, 500).map((p) => [p.spotMove1sBp.toFixed(2), p.markout5Cents.toFixed(2), p.side]) }}>
      {pts.length ? (
        <ResponsiveContainer width="100%" height={H}>
          <ScatterChart margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
            <CartesianGrid {...gridProps} vertical />
            <XAxis dataKey="spotMove1sBp" type="number" name="spot move" {...axisProps} tickFormatter={(v: number) => `${v}bp`} />
            <YAxis dataKey="markout5Cents" type="number" name="5 s markout" {...axisProps} tickFormatter={(v: number) => `${v}¢`} width={48} />
            <Tooltip {...tooltipProps} formatter={(v, n) => [n === "spot move" ? `${Number(v).toFixed(2)} bp` : fmt.cents(Number(v)), n]} />
            <ReferenceLine y={0} stroke={C.axis} />
            <ReferenceLine x={0} stroke={C.axis} />
            <Scatter data={pts} fill={C.slot[0]} fillOpacity={0.5} shape="circle" isAnimationActive={false} />
          </ScatterChart>
        </ResponsiveContainer>
      ) : (
        <Empty>No fills.</Empty>
      )}
    </Panel>
  );
}

/** V10: halfSpread × skewPerShare → OUT-OF-SAMPLE edge (other params at the chosen config), t-stat in each cell. */
export function SweepHeatmap({ s }: { s: Sweep | null }) {
  if (!s) {
    return (
      <Panel id="V10" title="Parameter sweep" question="Which parameters are robust (plateau) vs overfit (spike)?">
        <Empty>No sweep yet: run `pnpm sweep` then `pnpm report &lt;id&gt;`.</Empty>
      </Panel>
    );
  }
  const sw = s.sweep;
  const [ax, ay] = sw.plateauAxes as [string, string];
  const xs = sw.params.find(([p]) => p === ax)![1];
  const ys = sw.params.find(([p]) => p === ay)![1];
  const chosen = sw.configs.find((c) => c.id === sw.chosenId)!;
  const slice = sw.configs.filter((c) => sw.params.every(([p]) => p === ax || p === ay || c.overrides[p] === chosen.overrides[p]));
  const cellOf = (x: unknown, y: unknown) => slice.find((c) => c.overrides[ax] === x && c.overrides[ay] === y);
  const vals = slice.map((c) => c.oos.edgeCentsExRebates).filter((v): v is number => v !== null);
  const max = Math.max(1e-9, ...vals.map(Math.abs));
  const short = (p: string) => p.split(".").at(-1)!;
  const fixed = sw.params.filter(([p]) => p !== ax && p !== ay).map(([p]) => `${short(p)} = ${chosen.overrides[p]}`).join(", ");
  return (
    <Panel
      id="V10"
      title="Parameter sweep (out-of-sample)"
      question={`${sw.configsTried} configs tried · chosen on in-sample only (outlined) · plateau ${sw.plateau.pass ? "PASS" : "FAIL"}${fixed ? ` · ${fixed}` : ""}`}
      table={{ columns: [short(ax), short(ay), "IS edge ¢/sh", "OOS edge ¢/sh", "OOS t"], rows: slice.map((c) => [String(c.overrides[ax]), String(c.overrides[ay]), fmt.num(c.is.edgeCentsExRebates, 3), fmt.num(c.oos.edgeCentsExRebates, 3), fmt.num(c.oos.tStat, 2)]) }}
    >
      <div className="sweep-grid" style={{ gridTemplateColumns: `90px repeat(${xs.length}, minmax(56px, 1fr))` }}>
        <div className="heat-corner">{short(ay)} ↓ / {short(ax)} →</div>
        {xs.map((x) => (
          <div key={String(x)} className="heat-col num">{String(x)}</div>
        ))}
        {ys.map((y) => [
          <div key={`${String(y)}-l`} className="heat-row num">{String(y)}</div>,
          ...xs.map((x) => {
            const c = cellOf(x, y);
            const v = c?.oos.edgeCentsExRebates ?? null;
            return (
              <div
                key={`${String(x)}-${String(y)}`}
                className={`sweep-cell${c?.id === sw.chosenId ? " chosen" : ""}`}
                style={{ background: diverging(v, max) }}
                title={c ? `${c.id}: OOS ${fmt.cents(v, 3)} (t ${fmt.num(c.oos.tStat, 2)}), IS ${fmt.cents(c.is.edgeCentsExRebates, 3)}` : "not run"}
              >
                <span className="num">{fmt.num(v, 2)}</span>
                <span className="num t">t {fmt.num(c?.oos.tStat, 1)}</span>
              </div>
            );
          }),
        ])}
      </div>
      <div className="heat-foot">
        <span>¢/share excl. rebates, {sw.mode} fills</span>
        <span className="heat-scale">
          <span className="num">{fmt.num(-max, 1)}</span>
          <span className="heat-ramp" style={{ background: `linear-gradient(90deg, ${C.divNeg}, ${C.divMid}, ${C.divPos})` }} />
          <span className="num">{fmt.num(max, 1)}</span>
        </span>
      </div>
    </Panel>
  );
}

/** Go / No-Go (PLAN.md §10) from the latest sweep's report. */
export function GoNoGo({ s }: { s: Sweep | null }) {
  const r = s?.report;
  return (
    <section className="panel wide gonogo" aria-labelledby="gng-t">
      <header className="panel-head">
        <div>
          <h2 id="gng-t">
            Go / No-Go {r && <span className={`verdict ${r.verdict === "GO" ? "go" : "nogo"}`}>{r.verdict === "GO" ? "✓ GO" : "✕ NO-GO"}</span>}
          </h2>
          <p>{s ? `Sweep ${s.id} · out-of-sample run ${s.sweep.oosRunId ?? "—"} · pessimistic fills · every criterion must hold` : "No sweep yet."}</p>
        </div>
      </header>
      {r ? (
        <div className="table-scroll tall">
          <table>
            <thead>
              <tr>
                <th>Criterion</th>
                <th>Threshold</th>
                <th>Value</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {r.criteria.map((c) => (
                <tr key={c.name}>
                  <td>{c.name}</td>
                  <td className="muted-cell">{c.threshold}</td>
                  <td className="num wrap">{c.value}</td>
                  <td className={c.pass ? "pass" : "fail"}>{c.pass ? "✓ PASS" : "✕ FAIL"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>{s ? `Run pnpm report ${s.id}` : "Run pnpm sweep, then pnpm report <id>."}</Empty>
      )}
    </section>
  );
}

/** V11: bootstrap distribution of mean PnL per market. */
export function BootstrapDist({ m }: { m: ModeAnalysis }) {
  const bs = m.bootstrap.meanPnlPerMarket;
  const bins = histogram(bs.sample, 30);
  return (
    <Panel
      id="V11"
      title="Bootstrap distribution"
      question={`How confident am I that edge > 0? P(mean > 0) = ${fmt.num(bs.pPositive, 3)} · ${bs.blocks} ${m.bootstrap.blockBy} blocks`}
      legend={[{ label: "Resampled mean PnL/market", color: C.slot[0]! }, { label: "95% CI", color: C.inkStrong }]}
      table={{ columns: ["from $", "to $", "draws"], rows: bins.map((b) => [b.lo.toFixed(2), b.hi.toFixed(2), b.n]) }}
    >
      {bins.length ? (
        <ResponsiveContainer width="100%" height={H}>
          <BarChart data={bins} margin={{ top: 8, right: 16, bottom: 0, left: 8 }} barCategoryGap={1}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="x" type="number" domain={["dataMin", "dataMax"]} {...axisProps} tickFormatter={(v: number) => fmt.usd(v, 0)} />
            <YAxis {...axisProps} width={36} />
            <Tooltip {...tooltipProps} labelFormatter={(v) => `mean ≈ ${fmt.usd(Number(v))}`} formatter={(v) => [`${v} draws`, "count"]} />
            <Bar dataKey="n" fill={C.slot[0]} fillOpacity={0.55} radius={[4, 4, 0, 0]} isAnimationActive={false} />
            <ReferenceLine x={bs.lo95} stroke={C.inkStrong} strokeWidth={2} />
            <ReferenceLine x={bs.hi95} stroke={C.inkStrong} strokeWidth={2} />
            <ReferenceLine x={0} stroke={C.axis} strokeDasharray="4 3" />
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <Empty>Not enough markets to bootstrap.</Empty>
      )}
    </Panel>
  );
}

/** V12: net edge per fill mode, with and without rebates, with 95% CIs. */
export function ModeComparison({ a }: { a: RunAnalysis }) {
  const data = a.modes.map((m) => ({
    mode: MODE_LABEL[m.mode],
    incl: m.edgeCents,
    inclErr: [m.edgeCents - m.bootstrap.edgeCents.lo95, m.bootstrap.edgeCents.hi95 - m.edgeCents],
    excl: m.edgeCentsExRebates,
    exclErr: [m.edgeCentsExRebates - m.bootstrap.edgeCentsExRebates.lo95, m.bootstrap.edgeCentsExRebates.hi95 - m.edgeCentsExRebates],
  }));
  return (
    <Panel
      id="V12"
      title="Fill-mode comparison"
      question="Does the edge survive pessimistic fills?"
      legend={[{ label: "Incl. rebates", color: C.slot[0]! }, { label: "Excl. rebates", color: C.slot[1]! }]}
      table={{ columns: ["mode", "edge incl ¢/sh", "edge excl ¢/sh"], rows: data.map((d) => [d.mode, fmt.num(d.incl, 3), fmt.num(d.excl, 3)]) }}
    >
      <ResponsiveContainer width="100%" height={H}>
        <BarChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 8 }} barGap={2}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="mode" {...axisProps} />
          <YAxis {...axisProps} tickFormatter={(v: number) => `${v}¢`} width={48} />
          <Tooltip {...tooltipProps} cursor={{ fill: C.grid, fillOpacity: 0.4 }} formatter={(v) => fmt.cents(Number(v), 3)} />
          <ReferenceLine y={0} stroke={C.axis} />
          <Bar dataKey="incl" name="Incl. rebates" fill={C.slot[0]} radius={[4, 4, 0, 0]} isAnimationActive={false}>
            <ErrorBar dataKey="inclErr" stroke={C.ink} strokeWidth={1.5} width={6} />
          </Bar>
          <Bar dataKey="excl" name="Excl. rebates" fill={C.slot[1]} radius={[4, 4, 0, 0]} isAnimationActive={false}>
            <ErrorBar dataKey="exclErr" stroke={C.ink} strokeWidth={1.5} width={6} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </Panel>
  );
}
