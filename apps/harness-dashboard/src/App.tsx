// Layout shell for PLAN.md §8. Panels are placeholders until Phase 9 wires them to DuckDB.

const kpis = ["Net PnL", "Edge ¢/share", "95% CI", "t-stat", "Max DD"];

const rows: [[string, string], [string, string]][] = [
  [["V2 Markout curve", "How fast am I being picked off?"], ["V3 Per-market PnL", "Is the edge broad or a few lucky markets?"]],
  [["V5 Minute × FV heatmap", "Where in the window do I lose?"], ["V8 Reliability diagram", "Is fair value calibrated vs the market?"]],
  [["V9 Spot jump vs markout", "Are toxic fills explained by spot jumps?"], ["V4 Drawdown", "How much pain before recovery?"]],
];

function Panel({ title, question, wide }: { title: string; question: string; wide?: boolean }) {
  return (
    <section className={wide ? "panel wide" : "panel"}>
      <h2>{title}</h2>
      <p>{question}</p>
    </section>
  );
}

export function App() {
  return (
    <>
      <header className="topbar">
        <span className="brand">RainTrade</span>
        <div className="filters">
          <span className="chip">Run: —</span>
          <span className="chip">Mode: Pessimistic</span>
          <span className="chip">Range: Last 21 days</span>
          <span className="chip">Coin: BTC</span>
        </div>
      </header>
      <main>
        <div className="kpis">
          {kpis.map((k) => (
            <div className="kpi" key={k}>
              <div className="kpi-label">{k}</div>
              <div className="kpi-value num">—</div>
            </div>
          ))}
        </div>
        <Panel wide title="V1 Cumulative PnL" question="Is it making money, and from what?" />
        {rows.map((pair) => (
          <div className="grid-2" key={pair[0][0]}>
            {pair.map(([t, q]) => (
              <Panel key={t} title={t} question={q} />
            ))}
          </div>
        ))}
        <Panel wide title="Markets" question="Sortable per-market table; click a row for the V7 drill-down." />
      </main>
    </>
  );
}
