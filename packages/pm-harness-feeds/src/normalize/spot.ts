import type { MarketEvent } from "@rain/pm-harness-core";

// Raw shapes: docs/samples/spot-feeds.ndjson, docs/samples/rtds.ndjson, docs/samples/boundary-feeds.ndjson.gz.

interface RtdsUpdate {
  topic: "crypto_prices_chainlink";
  type: "update";
  payload: { symbol: string; timestamp: number; value: number; full_accuracy_value?: string };
}

interface RtdsBackfill {
  topic: "crypto_prices";
  type: "subscribe";
  payload: { symbol: string; data: { timestamp: number; value: number }[] };
}

/** Chainlink ticks from Polymarket RTDS, including the ~59 s backfill sent on every subscribe. */
export function normalizeRtds(raw: string, symbol: string, recvTs: bigint): MarketEvent[] {
  if (raw === "" || raw === "PONG") return [];
  const m = JSON.parse(raw) as RtdsUpdate | RtdsBackfill | { topic?: string; type?: string };
  if (m.topic === "crypto_prices_chainlink" && m.type === "update") {
    const p = (m as RtdsUpdate).payload;
    if (p.symbol !== symbol) return [];
    return [
      {
        kind: "res_price",
        exchangeTs: p.timestamp,
        recvTs,
        payload: {
          source: "chainlink",
          symbol,
          price: p.value,
          ...(p.full_accuracy_value ? { scaled: p.full_accuracy_value } : {}),
        },
      },
    ];
  }
  if (m.topic === "crypto_prices" && m.type === "subscribe") {
    const p = (m as RtdsBackfill).payload;
    if (p.symbol !== symbol) return [];
    return p.data.map((d) => ({
      kind: "res_price" as const,
      exchangeTs: d.timestamp,
      recvTs,
      payload: { source: "chainlink" as const, symbol, price: d.value, backfill: true },
    }));
  }
  return [];
}

interface BinanceEnvelope {
  stream: string;
  data:
    | { s: string; b: string; B: string; a: string; A: string } // bookTicker: no exchange timestamp
    | { e: "aggTrade"; T: number; p: string; q: string; m: boolean };
}

/** Binance combined stream (bookTicker + aggTrade). bookTicker has no timestamp, so exchangeTs = local wall ms. */
export function normalizeBinance(raw: string, recvTs: bigint, wallMs: number): MarketEvent[] {
  const m = JSON.parse(raw) as BinanceEnvelope;
  const d = m.data;
  if (m.stream?.endsWith("@bookTicker") && "b" in d) {
    return [
      {
        kind: "spot",
        exchangeTs: wallMs,
        recvTs,
        payload: { type: "bbo", source: "binance", bid: +d.b, bidSize: +d.B, ask: +d.a, askSize: +d.A },
      },
    ];
  }
  if (m.stream?.endsWith("@aggTrade") && "T" in d) {
    return [
      {
        kind: "spot",
        exchangeTs: d.T,
        recvTs,
        // m = buyer is maker, so the taker sold
        payload: { type: "trade", source: "binance", price: +d.p, size: +d.q, side: d.m ? "SELL" : "BUY" },
      },
    ];
  }
  return [];
}

interface CoinbaseTicker {
  type: "ticker";
  time: string;
  price: string;
  last_size: string;
  side: "buy" | "sell";
  best_bid: string;
  best_bid_size: string;
  best_ask: string;
  best_ask_size: string;
}

/** Coinbase `ticker`: one message per match batch → a trade plus the post-trade BBO. `side` is the taker side. */
export function normalizeCoinbase(raw: string, recvTs: bigint): MarketEvent[] {
  const m = JSON.parse(raw) as CoinbaseTicker | { type: string };
  if (m.type !== "ticker") return [];
  const t = m as CoinbaseTicker;
  const exchangeTs = Date.parse(t.time);
  return [
    {
      kind: "spot",
      exchangeTs,
      recvTs,
      payload: {
        type: "trade",
        source: "coinbase",
        price: +t.price,
        size: +t.last_size,
        side: t.side === "buy" ? "BUY" : "SELL",
      },
    },
    {
      kind: "spot",
      exchangeTs,
      recvTs,
      payload: {
        type: "bbo",
        source: "coinbase",
        bid: +t.best_bid,
        bidSize: +t.best_bid_size,
        ask: +t.best_ask,
        askSize: +t.best_ask_size,
      },
    },
  ];
}
