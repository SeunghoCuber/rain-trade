import { useMemo, useState } from "react";
import type { Mode, TradeRow } from "../api.ts";
import { fmt, tzName } from "../theme/chart.ts";

// Every simulated fill as a timeline: markets newest first, trades in time order inside each market,
// described in plain terms (what we bought or sold, whether the next 5 s proved it right, where the
// position ended up, and what the fill made at settlement).

interface MarketGroup {
  marketId: string;
  slug: string;
  windowStart: number;
  outcome: number;
  marketPnl: number;
  trades: TradeRow[];
}

const PAGE = 12;
const mmss = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Plain-language description of one fill (orders are in UP terms; selling UP you don't hold = buying DOWN). */
function describe(t: TradeRow): { main: string; sub: string | null } {
  const q = t.size.toFixed(0);
  if (t.side === "BUY") return { main: `Bought ${q} UP @ ${t.price.toFixed(3)}`, sub: null };
  const fromUp = Math.max(0, Math.min(t.size, t.inventory_before));
  const asDown = t.size - fromUp;
  if (asDown <= 1e-9) return { main: `Sold ${q} UP @ ${t.price.toFixed(3)}`, sub: null };
  if (fromUp <= 1e-9) return { main: `Bought ${q} DOWN @ ${(1 - t.price).toFixed(3)}`, sub: `our UP ask @ ${t.price.toFixed(3)} was hit` };
  return { main: `Sold ${fromUp.toFixed(0)} UP + bought ${asDown.toFixed(0)} DOWN`, sub: `UP ask @ ${t.price.toFixed(3)}` };
}

function Signed({ v, unit }: { v: number | null; unit: "¢" | "$" }) {
  if (v === null || !Number.isFinite(v)) return <span className="muted-text">—</span>;
  const cls = v > 0 ? "up" : v < 0 ? "down" : "";
  const text = unit === "$" ? fmt.usd(v) : fmt.cents(v, 1);
  return (
    <span className={`num ${cls}`}>
      {v > 0 ? "▲ " : v < 0 ? "▼ " : ""}
      {v > 0 && unit === "¢" ? "+" : ""}
      {text}
    </span>
  );
}

function PositionBar({ inv, max }: { inv: number; max: number }) {
  const frac = max > 0 ? Math.min(1, Math.abs(inv) / max) : 0;
  return (
    <span className="posbar" title={`position after: ${inv.toFixed(0)} UP-equivalent shares`}>
      <span className="posbar-track">
        <span className={`posbar-fill ${inv >= 0 ? "long" : "short"}`} style={inv >= 0 ? { left: "50%", width: `${frac * 50}%` } : { right: "50%", width: `${frac * 50}%` }} />
        <span className="posbar-zero" />
      </span>
      <span className="num posbar-label">{inv > 0 ? `+${inv.toFixed(0)}` : inv.toFixed(0)}</span>
    </span>
  );
}

export function TradeTimeline({ trades, mode, onOpenMarket }: { trades: TradeRow[]; mode: Mode; onOpenMarket: (id: string) => void }) {
  const [shown, setShown] = useState(PAGE);
  const groups = useMemo(() => {
    const by = new Map<string, MarketGroup>();
    for (const t of trades) {
      let g = by.get(t.market_id);
      if (!g) by.set(t.market_id, (g = { marketId: t.market_id, slug: t.slug, windowStart: t.window_start, outcome: t.outcome, marketPnl: t.market_pnl, trades: [] }));
      g.trades.push(t);
    }
    const list = [...by.values()].sort((a, b) => b.windowStart - a.windowStart);
    for (const g of list) g.trades.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    return list;
  }, [trades]);
  const maxPos = useMemo(() => Math.max(1, ...trades.map((t) => Math.abs(t.inventory_before + (t.side === "BUY" ? t.size : -t.size)))), [trades]);
  const tz = tzName();

  return (
    <section className="panel wide" aria-labelledby="tt-t">
      <header className="panel-head">
        <div>
          <h2 id="tt-t">Trades</h2>
          <p>
            Every simulated fill ({mode}): markets newest first, trades in time order within each. The dot and 5 s column say whether fair value moved our way
            right after the fill (▲ green) or against us (▼ red). "At settlement" is what that fill made once the market resolved.
          </p>
        </div>
      </header>
      {groups.length === 0 ? (
        <div className="empty">No fills in this run and mode.</div>
      ) : (
        <div className="timeline">
          <div className="tl-cols" aria-hidden="true">
            <span>Time ({tz})</span>
            <span>Trade</span>
            <span>Fair value</span>
            <span>Next 5 s</span>
            <span>Position after</span>
            <span>At settlement</span>
          </div>
          {groups.slice(0, shown).map((g) => {
            const peak = Math.max(...g.trades.map((t) => Math.abs(t.inventory_before + (t.side === "BUY" ? t.size : -t.size))));
            return (
              <div key={g.marketId} className="tl-market">
                <button className="tl-head" onClick={() => onOpenMarket(g.marketId)} title="open this market in the drill-down chart">
                  <span className="tl-window num">
                    {fmt.time(g.windowStart)}–{fmt.clock(g.windowStart + 900_000).slice(0, 5)} {tz}
                  </span>
                  <span className={`tl-outcome ${g.outcome ? "up" : "down"}`}>{g.outcome ? "▲ UP won" : "▼ DOWN won"}</span>
                  <span className="tl-stat">
                    net <Signed v={g.marketPnl} unit="$" />
                  </span>
                  <span className="tl-stat muted-text">{g.trades.length} fills · peak {peak.toFixed(0)} shares</span>
                  <span className="tl-open">chart ↗</span>
                </button>
                <ol className="tl-rows">
                  {g.trades.map((t, i) => {
                    const d = t.side === "BUY" ? 1 : -1;
                    const mk = t.fv_h5 === null ? null : 100 * d * (t.fv_h5 - t.price);
                    const settle = d * (t.outcome - t.price) * t.size;
                    const after = t.inventory_before + d * t.size;
                    const { main, sub } = describe(t);
                    return (
                      <li key={`${t.ts}-${i}`} className="tl-row">
                        <span className="tl-time">
                          <span className={`tl-dot ${mk === null ? "" : mk >= 0 ? "good" : "bad"}`} />
                          <span className="num">{fmt.clock(t.ts)}</span>
                          <span className="num muted-text tl-left">T−{mmss(t.seconds_to_close)}</span>
                        </span>
                        <span className="tl-trade">
                          <span className={t.side === "BUY" ? "tl-side buy" : "tl-side sell"}>{t.side === "BUY" ? "BUY" : "SELL"}</span>
                          <span>
                            {main}
                            {sub && <span className="muted-text tl-sub"> · {sub}</span>}
                            {t.during_cancel_latency && <span className="tl-tag" title="filled while our cancel was in flight">during cancel</span>}
                            {t.through && <span className="tl-tag" title="a sweep traded through our price">swept</span>}
                          </span>
                        </span>
                        <span className="num">{t.fv_at_fill.toFixed(3)}</span>
                        <span>
                          <Signed v={mk} unit="¢" />
                        </span>
                        <PositionBar inv={after} max={maxPos} />
                        <span>
                          <Signed v={settle} unit="$" />
                        </span>
                      </li>
                    );
                  })}
                </ol>
              </div>
            );
          })}
          {shown < groups.length && (
            <button className="tl-more" onClick={() => setShown(shown + PAGE)}>
              Show {Math.min(PAGE, groups.length - shown)} more markets ({groups.length - shown} older)
            </button>
          )}
        </div>
      )}
    </section>
  );
}
