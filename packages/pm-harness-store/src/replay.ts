import { existsSync } from "node:fs";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { LevelChange, MarketEvent, Side, Token } from "@rain/pm-harness-core";
import { isCompacted, parquetPath } from "./compact.ts";
import { listRawHours, readRawHour } from "./raw.ts";
import { TABLE_NAMES } from "./tables.ts";

export interface ReplayOptions {
  /** inclusive start, ms (recv time) */
  fromMs?: number;
  /** exclusive end, ms (recv time) */
  toMs?: number;
  /** only these markets' events (plus every market-less event: spot, Chainlink, global gaps) */
  marketIds?: readonly string[];
  /** read uncompacted hours (incl. the one being written) from raw NDJSON; default true */
  includeRaw?: boolean;
  /** read every hour from raw NDJSON, ignoring Parquet (to verify compaction is lossless) */
  rawOnly?: boolean;
}

export interface ReplayHour {
  date: string;
  hour: number;
  source: "parquet" | "raw";
}

const HOUR = 3_600_000;
const sqlStr = (s: string) => `'${s.replaceAll("'", "''")}'`;
const hourStart = (date: string, hour: number) => Date.parse(`${date}T00:00:00Z`) + hour * HOUR;

/** Hours to replay, oldest first; compacted hours come from Parquet, the rest from raw. */
export function replayHours(dataDir: string, opts: ReplayOptions = {}): ReplayHour[] {
  const out: ReplayHour[] = [];
  for (const h of listRawHours(dataDir)) {
    const start = hourStart(h.date, h.hour);
    if (opts.fromMs !== undefined && start + HOUR <= opts.fromMs) continue;
    if (opts.toMs !== undefined && start >= opts.toMs) continue;
    if (!opts.rawOnly && isCompacted(dataDir, h.date, h.hour)) out.push({ date: h.date, hour: h.hour, source: "parquet" });
    else if (opts.includeRaw !== false) out.push({ date: h.date, hour: h.hour, source: "raw" });
  }
  return out;
}

type Row = Record<string, unknown>;
const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const big = (v: unknown) => (typeof v === "bigint" ? v : BigInt(v as number));

/** Rebuild one MarketEvent from the rows (same `line`) of one table. */
function toEvent(table: string, rows: Row[]): MarketEvent {
  const r = rows[0]!;
  const base = {
    exchangeTs: Number(r.exchange_ts),
    recvTs: big(r.recv_ts),
    ...(r.market_id != null ? { marketId: r.market_id as string } : {}),
  };
  const tok = r.token != null ? { token: r.token as Token } : {};
  switch (table) {
    case "book_deltas":
      return {
        ...base,
        kind: "book_delta",
        payload: {
          changes: rows.map(
            (x): LevelChange => ({
              token: x.token as Token,
              side: x.side as Side,
              price: Number(x.price),
              size: Number(x.size),
              bestBid: n(x.best_bid),
              bestAsk: n(x.best_ask),
            }),
          ),
        },
      };
    case "book_levels": {
      const lv = (side: Side) => rows.filter((x) => x.side === side && x.price != null).map((x) => ({ price: Number(x.price), size: Number(x.size) }));
      return { ...base, ...tok, kind: "book_snapshot", payload: { bids: lv("BUY"), asks: lv("SELL"), hash: r.hash as string } };
    }
    case "trades":
      return {
        ...base,
        ...tok,
        kind: "trade",
        payload: { price: Number(r.price), size: Number(r.size), side: r.side as Side, feeRateBps: Number(r.fee_rate_bps), txHash: r.tx_hash as string },
      };
    case "spot":
      return r.type === "bbo"
        ? { ...base, kind: "spot", payload: { type: "bbo", source: r.source as "binance", bid: Number(r.bid), bidSize: Number(r.bid_size), ask: Number(r.ask), askSize: Number(r.ask_size) } }
        : { ...base, kind: "spot", payload: { type: "trade", source: r.source as "binance", price: Number(r.price), size: Number(r.size), side: r.side as Side } };
    case "res_prices":
      return {
        ...base,
        kind: "res_price",
        payload: {
          source: "chainlink",
          symbol: r.symbol as string,
          price: Number(r.price),
          ...(r.scaled != null ? { scaled: r.scaled as string } : {}),
          ...(r.backfill ? { backfill: true } : {}),
        },
      };
    case "market_opens":
      return {
        ...base,
        kind: "market_open",
        payload: {
          slug: r.slug as string,
          upTokenId: r.up_token_id as string,
          downTokenId: r.down_token_id as string,
          windowStart: Number(r.window_start),
          windowEnd: Number(r.window_end),
          tickSize: Number(r.tick_size),
          minOrderSize: Number(r.min_order_size),
          feeSchedule: { rate: Number(r.fee_rate), exponent: Number(r.fee_exponent), takerOnly: Boolean(r.fee_taker_only), rebateRate: Number(r.fee_rebate_rate) },
        },
      };
    case "market_closes":
      return { ...base, kind: "market_close", payload: { windowEnd: Number(r.window_end) } };
    case "resolutions":
      return { ...base, kind: "resolution", payload: { outcome: r.outcome as Token, priceToBeat: Number(r.price_to_beat), finalPrice: Number(r.final_price) } };
    case "feed_gaps":
      return { ...base, kind: "feed_gap", payload: { feed: r.feed as string, gapMs: Number(r.gap_ms), reason: r.reason as "reconnect" } };
    case "tick_size_changes":
      return { ...base, ...tok, kind: "tick_size_change", payload: { oldTickSize: Number(r.old_tick_size), newTickSize: Number(r.new_tick_size) } };
    case "venue_raw":
      return { ...base, kind: "venue_raw", payload: { feed: r.feed as string, eventType: r.event_type as string, data: r.data as string } };
    default:
      throw new Error(`unknown table ${table}`);
  }
}

async function* parquetHour(conn: DuckDBConnection, dataDir: string, date: string, hour: number, where: string): AsyncGenerator<MarketEvent> {
  const parts: string[] = [];
  for (const t of TABLE_NAMES) {
    const f = parquetPath(dataDir, t, date, hour);
    if (existsSync(f)) parts.push(`SELECT '${t}' AS _t, * FROM read_parquet(${sqlStr(f)})`);
  }
  if (!parts.length) return;
  // one sorted stream per hour: `line` is the raw file's line = recorded order; idx orders the rows
  // of one event (a delta's changes, a snapshot's levels). (line, idx) is unique, so the order is total.
  const sql = `SELECT * FROM (${parts.join(" UNION ALL BY NAME ")}) ${where} ORDER BY line, idx NULLS FIRST`;
  const result = await conn.stream(sql);
  const cols = result.columnNames();
  let group: Row[] = [];
  let groupKey = "";
  for await (const batch of result.yieldRowsJs()) {
    for (const vals of batch) {
      const row: Row = {};
      for (let i = 0; i < cols.length; i++) row[cols[i]!] = vals[i];
      const key = `${row.line}`;
      if (key !== groupKey && group.length) {
        yield toEvent(group[0]!._t as string, group);
        group = [];
      }
      groupKey = key;
      group.push(row);
    }
  }
  if (group.length) yield toEvent(group[0]!._t as string, group);
}

/**
 * Replay recorded events in exact recorded order: Parquet for compacted hours, raw NDJSON for the
 * rest. Output is identical either way (see replay.test.ts).
 */
export async function* replay(conn: DuckDBConnection, dataDir: string, opts: ReplayOptions = {}): AsyncGenerator<MarketEvent> {
  const fromNs = opts.fromMs !== undefined ? BigInt(opts.fromMs) * 1_000_000n : null;
  const toNs = opts.toMs !== undefined ? BigInt(opts.toMs) * 1_000_000n : null;
  const markets = opts.marketIds ? new Set(opts.marketIds) : null;
  const conds: string[] = [];
  if (fromNs !== null) conds.push(`recv_ts >= ${fromNs}`);
  if (toNs !== null) conds.push(`recv_ts < ${toNs}`);
  if (markets) conds.push(`(market_id IS NULL OR market_id IN (${[...markets].map(sqlStr).join(", ") || "''"}))`);
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

  for (const h of replayHours(dataDir, opts)) {
    if (h.source === "parquet") {
      yield* parquetHour(conn, dataDir, h.date, h.hour, where);
      continue;
    }
    const raw = listRawHours(dataDir, [h.date]).find((x) => x.hour === h.hour);
    if (!raw) continue;
    for await (const r of readRawHour(raw.path)) {
      if ("error" in r) continue;
      const ev = r.ev;
      if (fromNs !== null && ev.recvTs < fromNs) continue;
      if (toNs !== null && ev.recvTs >= toNs) continue;
      if (markets && ev.marketId && !markets.has(ev.marketId)) continue;
      yield ev;
    }
  }
}
