import { useMemo, useState } from "react";
import type { MarketRow } from "../api.ts";
import { fmt, tzName } from "../theme/chart.ts";

type Key = "window_start" | "pnl" | "adverse" | "fills" | "max_inv" | "uptime";
const COLS: { key: Key; label: string; render: (r: MarketRow) => string }[] = [
  { key: "window_start", label: "Window", render: (r) => fmt.time(r.window_start) },
  { key: "pnl", label: "PnL", render: (r) => fmt.usd(r.pnl) },
  { key: "adverse", label: "Adverse", render: (r) => fmt.usd(r.adverse) },
  { key: "fills", label: "Fills", render: (r) => String(r.fills) },
  { key: "max_inv", label: "Max inv", render: (r) => r.max_inv.toFixed(0) },
  { key: "uptime", label: "Uptime", render: (r) => fmt.pct(r.uptime) },
];

/** Sortable per-market table; clicking a row opens the V7 drill-down. */
export function MarketTable({ rows, selected, onSelect }: { rows: MarketRow[]; selected: string | null; onSelect: (id: string) => void }) {
  const [sort, setSort] = useState<{ key: Key; desc: boolean }>({ key: "window_start", desc: true });
  const sorted = useMemo(() => [...rows].sort((a, b) => (sort.desc ? b[sort.key] - a[sort.key] : a[sort.key] - b[sort.key])), [rows, sort]);
  return (
    <section className="panel wide" aria-labelledby="mt-t">
      <header className="panel-head">
        <div>
          <h2 id="mt-t">Markets</h2>
          <p>{rows.length} settled in this run · excluded markets (feed gaps, late start, no resolution) are dimmed and left out of every headline number · click a row for the drill-down</p>
        </div>
      </header>
      <div className="table-scroll tall">
        <table className="markets">
          <thead>
            <tr>
              {COLS.map((c) => (
                <th key={c.key} aria-sort={sort.key === c.key ? (sort.desc ? "descending" : "ascending") : "none"}>
                  <button onClick={() => setSort({ key: c.key, desc: sort.key === c.key ? !sort.desc : true })}>
                    {c.key === "window_start" ? `${c.label} (${tzName()})` : c.label} {sort.key === c.key ? (sort.desc ? "▼" : "▲") : ""}
                  </button>
                </th>
              ))}
              <th>Outcome</th>
              <th>Flags</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.market_id} className={`${r.excluded ? "excluded" : ""} ${selected === r.market_id ? "selected" : ""}`} onClick={() => onSelect(r.market_id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onSelect(r.market_id)}>
                {COLS.map((c) => (
                  <td key={c.key} className={`num ${c.key === "pnl" ? (r.pnl > 0 ? "up" : r.pnl < 0 ? "down" : "") : ""}`}>
                    {c.key === "pnl" && r.pnl !== 0 ? (r.pnl > 0 ? "▲ " : "▼ ") : ""}
                    {c.render(r)}
                  </td>
                ))}
                <td>{r.outcome ? "UP" : "DOWN"}</td>
                <td className="flags">{r.flags || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
