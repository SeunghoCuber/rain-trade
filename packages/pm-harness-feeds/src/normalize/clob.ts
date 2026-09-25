import type { LevelChange, MarketEvent, Side, Token } from "@rain/pm-harness-core";

// Raw CLOB market-channel shapes (docs/samples/clob-ws-market.ndjson.gz).

interface RawLevel {
  price: string;
  size: string;
}

interface RawBook {
  event_type: "book";
  asset_id: string;
  timestamp: string;
  hash: string;
  bids: RawLevel[];
  asks: RawLevel[];
}

interface RawPriceChange {
  asset_id: string;
  price: string;
  size: string;
  side: Side;
  best_bid?: string;
  best_ask?: string;
}

interface RawPriceChangeMsg {
  event_type: "price_change";
  timestamp: string;
  price_changes: RawPriceChange[];
}

interface RawTrade {
  event_type: "last_trade_price";
  asset_id: string;
  price: string;
  size: string;
  side: Side;
  fee_rate_bps?: string;
  timestamp: string;
  transaction_hash?: string;
}

interface RawTickSizeChange {
  event_type: "tick_size_change";
  asset_id: string;
  old_tick_size: string;
  new_tick_size: string;
  timestamp: string;
}

type RawClobMsg = RawBook | RawPriceChangeMsg | RawTrade | RawTickSizeChange | { event_type?: string };

export interface ClobContext {
  marketId: string;
  upTokenId: string;
  downTokenId: string;
  /** drop DOWN book data that exactly mirrors UP (see docs/VERIFIED.md §3) */
  dropMirrored: boolean;
}

export interface ClobResult {
  events: MarketEvent[];
  /** DOWN changes that were NOT an exact mirror of an UP change in the same message (kept) */
  mirrorMismatches: number;
  /** event_types we do not normalize; each is also emitted verbatim as a venue_raw event */
  unknownTypes: string[];
}

const num = (s: string) => Number(s);
const optPrice = (s: string | undefined) => (s === undefined || s === "" ? null : Number(s));
const isMirror = (u: LevelChange, d: LevelChange) =>
  u.side !== d.side && u.size === d.size && Math.abs(u.price + d.price - 1) < 1e-9;

export function normalizeClob(raw: string, ctx: ClobContext, recvTs: bigint): ClobResult {
  const out: ClobResult = { events: [], mirrorMismatches: 0, unknownTypes: [] };
  if (raw === "PONG" || raw === "") return out;
  const parsed = JSON.parse(raw) as RawClobMsg | RawClobMsg[];
  const msgs = Array.isArray(parsed) ? parsed : [parsed];

  const unknown = (m: RawClobMsg) => {
    const eventType = String(m.event_type);
    out.unknownTypes.push(eventType);
    out.events.push({
      kind: "venue_raw",
      marketId: ctx.marketId,
      exchangeTs: Number((m as { timestamp?: string }).timestamp ?? 0),
      recvTs,
      payload: { feed: "clob", eventType, data: JSON.stringify(m) },
    });
  };

  const tokenOf = (assetId: string): Token | null =>
    assetId === ctx.upTokenId ? "UP" : assetId === ctx.downTokenId ? "DOWN" : null;

  for (const m of msgs) {
    switch (m.event_type) {
      case "book": {
        const b = m as RawBook;
        const token = tokenOf(b.asset_id);
        if (!token || (ctx.dropMirrored && token === "DOWN")) break;
        out.events.push({
          kind: "book_snapshot",
          marketId: ctx.marketId,
          token,
          exchangeTs: num(b.timestamp),
          recvTs,
          payload: {
            bids: b.bids.map((l) => ({ price: num(l.price), size: num(l.size) })),
            asks: b.asks.map((l) => ({ price: num(l.price), size: num(l.size) })),
            hash: b.hash,
          },
        });
        break;
      }
      case "price_change": {
        const pc = m as RawPriceChangeMsg;
        const ups: LevelChange[] = [];
        const downs: LevelChange[] = [];
        for (const c of pc.price_changes) {
          const token = tokenOf(c.asset_id);
          if (!token) continue;
          const lc: LevelChange = {
            token,
            side: c.side,
            price: num(c.price),
            size: num(c.size),
            bestBid: optPrice(c.best_bid),
            bestAsk: optPrice(c.best_ask),
          };
          (token === "UP" ? ups : downs).push(lc);
        }
        let changes = [...ups, ...downs];
        if (ctx.dropMirrored) {
          const unmatched = [...ups];
          const keptDowns = downs.filter((d) => {
            const i = unmatched.findIndex((u) => isMirror(u, d));
            if (i === -1) return true;
            unmatched.splice(i, 1);
            return false;
          });
          out.mirrorMismatches += keptDowns.length;
          changes = [...ups, ...keptDowns];
        }
        if (changes.length === 0) break;
        out.events.push({
          kind: "book_delta",
          marketId: ctx.marketId,
          exchangeTs: num(pc.timestamp),
          recvTs,
          payload: { changes },
        });
        break;
      }
      case "last_trade_price": {
        const t = m as RawTrade;
        const token = tokenOf(t.asset_id);
        if (!token) break;
        out.events.push({
          kind: "trade",
          marketId: ctx.marketId,
          token,
          exchangeTs: num(t.timestamp),
          recvTs,
          payload: {
            price: num(t.price),
            size: num(t.size),
            side: t.side,
            feeRateBps: num(t.fee_rate_bps ?? "0"),
            txHash: t.transaction_hash ?? "",
          },
        });
        break;
      }
      case "tick_size_change": {
        const t = m as RawTickSizeChange;
        const token = tokenOf(t.asset_id);
        const oldTickSize = Number(t.old_tick_size);
        const newTickSize = Number(t.new_tick_size);
        if (token && oldTickSize > 0 && newTickSize > 0) {
          out.events.push({
            kind: "tick_size_change",
            marketId: ctx.marketId,
            token,
            exchangeTs: num(t.timestamp),
            recvTs,
            payload: { oldTickSize, newTickSize },
          });
          break;
        }
        unknown(m);
        break;
      }
      default:
        unknown(m);
    }
  }
  return out;
}
