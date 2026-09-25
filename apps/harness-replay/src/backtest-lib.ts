import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { ReplayClock, runReplay, type Config, type FillMode } from "@rain/pm-harness-core";
import { replay, writeParquet, type ReplayOptions } from "@rain/pm-harness-store";
import { BacktestRunner, type RunnerOptions, type Strategy } from "@rain/pm-harness-strategy";

export interface BacktestOptions {
  cfg: Config;
  conn: DuckDBConnection;
  runId: string;
  strategy: (mode: FillMode) => Strategy;
  replay?: ReplayOptions;
  quoteFv?: RunnerOptions["quoteFv"];
  /** write Parquet outputs to data/runs/<runId>/ */
  write?: boolean;
}

export interface BacktestOutput {
  runner: BacktestRunner;
  dir: string;
  digest: string;
  wallMs: number;
}

/** Replay recorded data through the strategy + fill simulator + ledger for all three fill modes. */
export async function backtest(o: BacktestOptions): Promise<BacktestOutput> {
  const t0 = Date.now();
  const clock = new ReplayClock();
  const runner = new BacktestRunner({ cfg: o.cfg, clock, strategy: o.strategy, ...(o.quoteFv ? { quoteFv: o.quoteFv } : {}) });
  await runReplay(replay(o.conn, o.cfg.recorder.dataDir, { rawOnly: true, ...o.replay }), clock, (ev) => runner.handle(ev));

  const fills = runner.allFills();
  const fv = runner.allFv();
  // results digest: identical inputs + config + code ⇒ identical bytes (sanity check 7)
  const h = createHash("sha256");
  const sorted = <T>(xs: T[], k: (x: T) => string) => [...xs].sort((a, b) => (k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0));
  for (const r of sorted(runner.results, (r) => `${r.mode}|${r.marketId}`)) h.update(JSON.stringify(r) + "\n");
  for (const f of sorted(fills, (f) => `${f.mode}|${f.ts}|${f.fillId}`)) h.update(JSON.stringify(f) + "\n");
  const digest = h.digest("hex");

  const dir = join(o.cfg.recorder.dataDir, "runs", o.runId);
  if (o.write !== false) {
    mkdirSync(dir, { recursive: true });
    await writeParquet(
      o.conn,
      join(dir, "fills.parquet"),
      [
        ["mode", "VARCHAR"], ["fill_id", "VARCHAR"], ["order_id", "VARCHAR"], ["market_id", "VARCHAR"], ["side", "VARCHAR"],
        ["price", "DOUBLE"], ["size", "DOUBLE"], ["ts", "BIGINT"], ["seconds_to_close", "DOUBLE"], ["fv_at_fill", "DOUBLE"],
        ["sigma_at_fill", "DOUBLE"], ["inventory_before", "DOUBLE"], ["during_cancel_latency", "BOOLEAN"], ["through", "BOOLEAN"],
        ["queue_ahead_at_live", "DOUBLE"], ["spot_move_1s_bp", "DOUBLE"], ["book_bid", "DOUBLE"], ["book_ask", "DOUBLE"],
        ["fv_h5", "DOUBLE"], ["outcome", "INTEGER"],
      ],
      fills.map((f) => [f.mode, f.fillId, f.orderId, f.marketId, f.side, f.price, f.size, f.ts, f.secondsToClose, f.fvAtFill, f.sigmaAtFill, f.inventoryBefore, f.duringCancelLatency, f.through, f.queueAheadAtLive, f.spotMove1sBp, f.bookBid, f.bookAsk, f.fvH5, f.outcome]),
    );
    await writeParquet(
      o.conn,
      join(dir, "markets.parquet"),
      [
        ["mode", "VARCHAR"], ["market_id", "VARCHAR"], ["slug", "VARCHAR"], ["window_start", "BIGINT"], ["outcome", "INTEGER"],
        ["pnl_trading", "DOUBLE"], ["pnl_spread", "DOUBLE"], ["pnl_adverse", "DOUBLE"], ["pnl_inventory", "DOUBLE"], ["rebate_est", "DOUBLE"],
        ["fees", "DOUBLE"], ["volume_filled", "DOUBLE"], ["buy_volume", "DOUBLE"], ["sell_volume", "DOUBLE"], ["fills", "INTEGER"],
        ["cancel_latency_fills", "INTEGER"], ["max_abs_inventory", "DOUBLE"], ["capital_used", "DOUBLE"], ["quote_uptime_pct", "DOUBLE"],
        ["realized_vol", "DOUBLE"], ["decomp_error", "DOUBLE"],
      ],
      runner.results.map((r) => [r.mode, r.marketId, r.slug, r.windowStart, r.outcome, r.pnlTrading, r.pnlSpread, r.pnlAdverse, r.pnlInventory, r.rebateEst, r.fees, r.volumeFilled, r.buyVolume, r.sellVolume, r.fills, r.cancelLatencyFills, r.maxAbsInventory, r.capitalUsed, r.quoteUptimePct, r.realizedVol, r.decompError]),
    );
    await writeParquet(
      o.conn,
      join(dir, "fv.parquet"),
      [["market_id", "VARCHAR"], ["ts", "BIGINT"], ["fv", "DOUBLE"], ["s", "DOUBLE"], ["s0", "DOUBLE"], ["sigma", "DOUBLE"], ["mid", "DOUBLE"]],
      fv.map((x) => [x.marketId, x.ts, x.fv, x.s, x.s0, x.sigma, x.mid]),
    );
    await writeParquet(
      o.conn,
      join(dir, "quotes.parquet"),
      [["mode", "VARCHAR"], ["market_id", "VARCHAR"], ["ts", "BIGINT"], ["bid", "DOUBLE"], ["ask", "DOUBLE"], ["fv", "DOUBLE"], ["inventory", "DOUBLE"], ["bid_impact", "DOUBLE"], ["ask_impact", "DOUBLE"]],
      runner.quotes.map((q) => [q.mode, q.marketId, q.ts, q.bid, q.ask, q.fv, q.inventory, q.bidImpact, q.askImpact]),
    );
    writeFileSync(
      join(dir, "run.json"),
      JSON.stringify(
        {
          runId: o.runId,
          strategy: runner.modes[0]?.strategy.name,
          createdAt: new Date().toISOString(),
          replay: o.replay ?? {},
          digest,
          events: runner.events,
          simStats: Object.fromEntries(runner.modes.map((m) => [m.mode, m.sim.stats])),
          config: o.cfg,
        },
        null,
        2,
      ),
    );
  }
  return { runner, dir, digest, wallMs: Date.now() - t0 };
}
