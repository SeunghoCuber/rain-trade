import type { ReactNode } from "react";

export interface TableSpec {
  columns: string[];
  rows: (string | number)[][];
}

/** A chart card: title, the question it answers, the chart, and a data-table view (accessibility). */
export function Panel({ id, title, question, children, table, wide, legend }: { id: string; title: string; question: string; children: ReactNode; table?: TableSpec; wide?: boolean; legend?: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <section className={wide ? "panel wide" : "panel"} aria-labelledby={`${id}-t`}>
      <header className="panel-head">
        <div>
          <h2 id={`${id}-t`}>
            <span className="vid">{id}</span> {title}
          </h2>
          <p>{question}</p>
        </div>
        {legend && legend.length > 1 && (
          <ul className="legend">
            {legend.map((l) => (
              <li key={l.label}>
                <span className={l.dashed ? "swatch dashed" : "swatch"} style={{ background: l.dashed ? undefined : l.color, borderColor: l.color }} />
                {l.label}
              </li>
            ))}
          </ul>
        )}
      </header>
      <div className="chart">{children}</div>
      {table && table.rows.length > 0 && (
        <details className="data-table">
          <summary>Show data ({table.rows.length} rows)</summary>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>{table.columns.map((c) => <th key={c}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {table.rows.slice(0, 500).map((r, i) => (
                  <tr key={i}>{r.map((v, j) => <td key={j} className="num">{v}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
