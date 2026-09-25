import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createViews } from "@rain/pm-harness-store";
import type { AnalyzeInput, FillIn, FvPoint, MarketIn, Mode, SimStats } from "./analyze.ts";

const sqlStr = (s: string) => `'${s.replaceAll("'", "''")}'`;
const rows = async (conn: DuckDBConnection, sql: string) => (await conn.runAndReadAll(sql)).getRowObjectsJS() as Record<string, unknown>[];

export const runDir = (dataDir: string, runId: string) => join(dataDir, "runs", runId);

/** Load a run's outputs, joined with market health (a market without a health row counts as excluded). */
export async function loadRun(conn: DuckDBConnection, dataDir: string, runId: string): Promise<AnalyzeInput & { runJson: Record<string, unknown> }> {
  const dir = runDir(dataDir, runId);
  if (!existsSync(join(dir, "markets.parquet"))) throw new Error(`no run at ${dir}`);
  await createViews(conn, dataDir);
  const p = (f: string) => sqlStr(join(dir, f));
  const markets: MarketIn[] = (
    await rows(
      conn,
      `SELECT r.*, coalesce(h.excluded, true) AS excluded, coalesce(h.flags, 'NOHEALTH') AS flags
       FROM read_parquet(${p("markets.parquet")}) r LEFT JOIN market_health h USING (market_id)`,
    )
  ).map((r) => ({
    mode: r.mode as Mode,
    marketId: r.market_id as string,
    slug: r.slug as string,
    windowStart: Number(r.window_start),
    outcome: Number(r.outcome) as 0 | 1,
    pnlTrading: Number(r.pnl_trading),
    pnlSpread: Number(r.pnl_spread),
    pnlAdverse: Number(r.pnl_adverse),
    pnlInventory: Number(r.pnl_inventory),
    rebateEst: Number(r.rebate_est),
    fees: Number(r.fees),
    volumeFilled: Number(r.volume_filled),
    fills: Number(r.fills),
    cancelLatencyFills: Number(r.cancel_latency_fills),
    maxAbsInventory: Number(r.max_abs_inventory),
    capitalUsed: Number(r.capital_used),
    quoteUptimePct: Number(r.quote_uptime_pct),
    realizedVol: Number(r.realized_vol),
    excluded: Boolean(r.excluded),
    flags: String(r.flags),
  }));
  const fills: FillIn[] = (await rows(conn, `SELECT * FROM read_parquet(${p("fills.parquet")}) ORDER BY ts`)).map((r) => ({
    mode: r.mode as Mode,
    marketId: r.market_id as string,
    side: r.side as "BUY" | "SELL",
    price: Number(r.price),
    size: Number(r.size),
    ts: Number(r.ts),
    secondsToClose: Number(r.seconds_to_close),
    fvAtFill: Number(r.fv_at_fill),
    inventoryBefore: Number(r.inventory_before),
    duringCancelLatency: Boolean(r.during_cancel_latency),
    spotMove1sBp: r.spot_move_1s_bp == null ? null : Number(r.spot_move_1s_bp),
    outcome: r.outcome == null ? null : (Number(r.outcome) as 0 | 1),
  }));
  const fv = new Map<string, FvPoint[]>();
  for (const r of await rows(conn, `SELECT market_id, ts, fv FROM read_parquet(${p("fv.parquet")}) ORDER BY market_id, ts`)) {
    const id = r.market_id as string;
    (fv.get(id) ?? fv.set(id, []).get(id)!).push({ ts: Number(r.ts), fv: Number(r.fv) });
  }
  const runJson = existsSync(join(dir, "run.json")) ? (JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as Record<string, unknown>) : {};
  const simStats = (runJson.simStats ?? {}) as Partial<Record<Mode, SimStats>>;
  return { markets, fills, fv, simStats, runJson };
}
