import type { MarketEvent } from "@rain/pm-harness-core";

// Columnar layout of the recorded MarketEvent stream. One Parquet file per table per UTC hour:
//   <dataDir>/parquet/<table>/date=YYYY-MM-DD/HH.parquet
// Every row carries (recv_ts, hour, line): `line` is the 1-based line in the raw hour file, so
// ORDER BY recv_ts, date, hour, line reproduces the exact recorded order (several events can share
// one recv_ts when they came from one WS message).

export type ColType = "VARCHAR" | "DOUBLE" | "BIGINT" | "INTEGER" | "SMALLINT" | "BOOLEAN";
export type Value = string | number | bigint | boolean | null;

export interface TableSpec {
  name: string;
  /** columns after the common prefix */
  columns: readonly (readonly [string, ColType])[];
}

export const COMMON_COLUMNS = [
  ["hour", "SMALLINT"],
  ["line", "INTEGER"],
  ["recv_ts", "BIGINT"],
  ["exchange_ts", "BIGINT"],
] as const satisfies readonly (readonly [string, ColType])[];

export const TABLES = {
  /** one row per level change; `idx` = position inside the event's changes array */
  book_deltas: {
    name: "book_deltas",
    columns: [
      ["market_id", "VARCHAR"],
      ["idx", "SMALLINT"],
      ["token", "VARCHAR"],
      ["side", "VARCHAR"],
      ["price", "DOUBLE"],
      ["size", "DOUBLE"],
      ["best_bid", "DOUBLE"],
      ["best_ask", "DOUBLE"],
    ],
  },
  /**
   * one row per level of a full book snapshot; side BUY = bids, SELL = asks; `idx` = position in
   * the snapshot (bids first, then asks) so replay reproduces it exactly; an empty book is one row with side NULL
   */
  book_levels: {
    name: "book_levels",
    columns: [
      ["market_id", "VARCHAR"],
      ["idx", "SMALLINT"],
      ["token", "VARCHAR"],
      ["side", "VARCHAR"],
      ["price", "DOUBLE"],
      ["size", "DOUBLE"],
      ["hash", "VARCHAR"],
    ],
  },
  /** `side` is the taker side */
  trades: {
    name: "trades",
    columns: [
      ["market_id", "VARCHAR"],
      ["token", "VARCHAR"],
      ["side", "VARCHAR"],
      ["price", "DOUBLE"],
      ["size", "DOUBLE"],
      ["fee_rate_bps", "DOUBLE"],
      ["tx_hash", "VARCHAR"],
    ],
  },
  /** type = bbo (bid/ask columns) or trade (price/size/side, taker side) */
  spot: {
    name: "spot",
    columns: [
      ["source", "VARCHAR"],
      ["type", "VARCHAR"],
      ["bid", "DOUBLE"],
      ["bid_size", "DOUBLE"],
      ["ask", "DOUBLE"],
      ["ask_size", "DOUBLE"],
      ["price", "DOUBLE"],
      ["size", "DOUBLE"],
      ["side", "VARCHAR"],
    ],
  },
  /** Chainlink ticks; exchange_ts is the tick's whole-second timestamp. `scaled` = price * 1e18 when known. */
  res_prices: {
    name: "res_prices",
    columns: [
      ["symbol", "VARCHAR"],
      ["price", "DOUBLE"],
      ["scaled", "VARCHAR"],
      ["backfill", "BOOLEAN"],
    ],
  },
  market_opens: {
    name: "market_opens",
    columns: [
      ["market_id", "VARCHAR"],
      ["slug", "VARCHAR"],
      ["up_token_id", "VARCHAR"],
      ["down_token_id", "VARCHAR"],
      ["window_start", "BIGINT"],
      ["window_end", "BIGINT"],
      ["tick_size", "DOUBLE"],
      ["min_order_size", "DOUBLE"],
      ["fee_rate", "DOUBLE"],
      ["fee_exponent", "DOUBLE"],
      ["fee_taker_only", "BOOLEAN"],
      ["fee_rebate_rate", "DOUBLE"],
    ],
  },
  market_closes: {
    name: "market_closes",
    columns: [
      ["market_id", "VARCHAR"],
      ["window_end", "BIGINT"],
    ],
  },
  resolutions: {
    name: "resolutions",
    columns: [
      ["market_id", "VARCHAR"],
      ["outcome", "VARCHAR"],
      ["price_to_beat", "DOUBLE"],
      ["final_price", "DOUBLE"],
    ],
  },
  feed_gaps: {
    name: "feed_gaps",
    columns: [
      ["market_id", "VARCHAR"],
      ["feed", "VARCHAR"],
      ["gap_ms", "DOUBLE"],
      ["reason", "VARCHAR"],
    ],
  },
  tick_size_changes: {
    name: "tick_size_changes",
    columns: [
      ["market_id", "VARCHAR"],
      ["token", "VARCHAR"],
      ["old_tick_size", "DOUBLE"],
      ["new_tick_size", "DOUBLE"],
    ],
  },
  venue_raw: {
    name: "venue_raw",
    columns: [
      ["market_id", "VARCHAR"],
      ["feed", "VARCHAR"],
      ["event_type", "VARCHAR"],
      ["data", "VARCHAR"],
    ],
  },
} as const satisfies Record<string, TableSpec>;

export type TableName = keyof typeof TABLES;
export const TABLE_NAMES = Object.keys(TABLES) as TableName[];

export function allColumns(t: TableSpec): (readonly [string, ColType])[] {
  return [...COMMON_COLUMNS, ...t.columns];
}

/** Map one event to (table, values) rows. Values align with the table's own columns (common prefix excluded). */
export function rowsFor(ev: MarketEvent): [TableName, Value[]][] {
  const mid = ev.marketId ?? null;
  switch (ev.kind) {
    case "book_delta":
      return ev.payload.changes.map((c, i) => [
        "book_deltas",
        [mid, i, c.token, c.side, c.price, c.size, c.bestBid, c.bestAsk],
      ]);
    case "book_snapshot":
      if (ev.payload.bids.length + ev.payload.asks.length === 0) {
        return [["book_levels", [mid, 0, ev.token ?? null, null, null, null, ev.payload.hash]]];
      }
      {
        const nb = ev.payload.bids.length;
        return [
          ...ev.payload.bids.map((l, i): [TableName, Value[]] => ["book_levels", [mid, i, ev.token ?? null, "BUY", l.price, l.size, ev.payload.hash]]),
          ...ev.payload.asks.map((l, i): [TableName, Value[]] => ["book_levels", [mid, nb + i, ev.token ?? null, "SELL", l.price, l.size, ev.payload.hash]]),
        ];
      }
    case "trade": {
      const p = ev.payload;
      return [["trades", [mid, ev.token ?? null, p.side, p.price, p.size, p.feeRateBps, p.txHash]]];
    }
    case "spot": {
      const p = ev.payload;
      return p.type === "bbo"
        ? [["spot", [p.source, "bbo", p.bid, p.bidSize, p.ask, p.askSize, null, null, null]]]
        : [["spot", [p.source, "trade", null, null, null, null, p.price, p.size, p.side]]];
    }
    case "res_price": {
      const p = ev.payload;
      return [["res_prices", [p.symbol, p.price, p.scaled ?? null, p.backfill ?? false]]];
    }
    case "market_open": {
      const p = ev.payload;
      const f = p.feeSchedule;
      return [
        [
          "market_opens",
          [mid, p.slug, p.upTokenId, p.downTokenId, p.windowStart, p.windowEnd, p.tickSize, p.minOrderSize, f.rate, f.exponent, f.takerOnly, f.rebateRate],
        ],
      ];
    }
    case "market_close":
      return [["market_closes", [mid, ev.payload.windowEnd]]];
    case "resolution": {
      const p = ev.payload;
      return [["resolutions", [mid, p.outcome, p.priceToBeat, p.finalPrice]]];
    }
    case "feed_gap": {
      const p = ev.payload;
      return [["feed_gaps", [mid, p.feed, p.gapMs, p.reason]]];
    }
    case "tick_size_change": {
      const p = ev.payload;
      return [["tick_size_changes", [mid, ev.token ?? null, p.oldTickSize, p.newTickSize]]];
    }
    case "venue_raw": {
      const p = ev.payload;
      return [["venue_raw", [mid, p.feed, p.eventType, p.data]]];
    }
  }
}
