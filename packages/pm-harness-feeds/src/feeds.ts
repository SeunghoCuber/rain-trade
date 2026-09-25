import type { Config, MarketEvent } from "@rain/pm-harness-core";
import type { MarketInfo } from "./gamma.ts";
import { normalizeClob } from "./normalize/clob.ts";
import { normalizeBinance, normalizeCoinbase, normalizeRtds } from "./normalize/spot.ts";
import { ResilientWs, type GapReason } from "./resilient-ws.ts";

export interface FeedHooks {
  emit: (ev: MarketEvent) => void;
  recvTs: () => bigint;
  now: () => number;
  onState: (feed: string, connected: boolean, detail: string) => void;
  onGap: (feed: string, gapMs: number, reason: GapReason | "sequence_break") => void;
  onEvents: (feed: string, n: number) => void;
  onParseError: (feed: string, err: Error, raw: string) => void;
  onUnknownType: (feed: string, type: string) => void;
  onMirrorMismatch: (feed: string, n: number) => void;
}

function gapEvent(h: FeedHooks, feed: string, gapMs: number, reason: GapReason | "sequence_break", marketId?: string, recvTs?: bigint): void {
  h.emit({
    kind: "feed_gap",
    ...(marketId ? { marketId } : {}),
    exchangeTs: h.now(),
    // a gap detected while handling a message shares that message's recvTs, so the stream stays in time order
    recvTs: recvTs ?? h.recvTs(),
    payload: { feed, gapMs, reason },
  });
  h.onGap(feed, gapMs, reason);
}

function handler(h: FeedHooks, feed: string, normalize: (raw: string, recvTs: bigint) => MarketEvent[]) {
  return (raw: string) => {
    let evs: MarketEvent[];
    try {
      evs = normalize(raw, h.recvTs());
    } catch (err) {
      h.onParseError(feed, err as Error, raw);
      return;
    }
    for (const ev of evs) h.emit(ev);
    if (evs.length) h.onEvents(feed, evs.length);
  };
}

export function clobFeedName(m: MarketInfo): string {
  return `clob:${m.slug}`;
}

/** One CLOB market-channel connection per market (both tokens). Reconnects resubscribe and get fresh snapshots. */
export function createClobFeed(cfg: Config, m: MarketInfo, h: FeedHooks): ResilientWs {
  const name = clobFeedName(m);
  const ctx = { marketId: m.marketId, upTokenId: m.upTokenId, downTokenId: m.downTokenId, dropMirrored: cfg.recorder.dropMirrored };
  return new ResilientWs({
    name,
    url: cfg.venue.clobWsUrl,
    silenceMs: cfg.recorder.silenceMs.clob,
    ping: { payload: "PING", intervalMs: 10_000 },
    now: h.now,
    onOpen: (send) => send(JSON.stringify({ assets_ids: [m.upTokenId, m.downTokenId], type: "market" })),
    onStateChange: (c, d) => h.onState(name, c, d),
    onGap: (gapMs, reason) => gapEvent(h, name, gapMs, reason, m.marketId),
    onMessage: (raw) => {
      let r;
      try {
        r = normalizeClob(raw, ctx, h.recvTs());
      } catch (err) {
        h.onParseError(name, err as Error, raw);
        return;
      }
      for (const ev of r.events) h.emit(ev);
      if (r.events.length) h.onEvents(name, r.events.length);
      if (r.mirrorMismatches) h.onMirrorMismatch(name, r.mirrorMismatches);
      for (const t of r.unknownTypes) h.onUnknownType(name, t);
    },
  });
}

/** Chainlink via Polymarket RTDS. Also reports skipped seconds as sequence breaks (they matter for the TWAP). */
export function createRtdsFeed(cfg: Config, h: FeedHooks): ResilientWs {
  const name = "rtds:chainlink";
  const symbol = `${cfg.market.coin}/usd`;
  let lastTickTs: number | null = null;
  const normalize = handler(h, name, (raw, recvTs) => {
    const evs = normalizeRtds(raw, symbol, recvTs);
    for (const ev of evs) {
      if (ev.kind !== "res_price" || ev.payload.backfill) continue;
      if (lastTickTs !== null && ev.exchangeTs - lastTickTs > 1000) {
        gapEvent(h, name, ev.exchangeTs - lastTickTs - 1000, "sequence_break", undefined, recvTs);
      }
      lastTickTs = Math.max(lastTickTs ?? 0, ev.exchangeTs);
    }
    return evs;
  });
  return new ResilientWs({
    name,
    url: cfg.venue.rtdsWsUrl,
    silenceMs: cfg.recorder.silenceMs.rtds,
    ping: { payload: "PING", intervalMs: 5_000 },
    now: h.now,
    onOpen: (send) =>
      send(
        JSON.stringify({
          action: "subscribe",
          subscriptions: [{ topic: "crypto_prices_chainlink", type: "*", filters: JSON.stringify({ symbol }) }],
        }),
      ),
    onStateChange: (c, d) => h.onState(name, c, d),
    // the resubscribe backfill (~59 s) covers short outages, so ticks are not lost; still record the gap
    onGap: (gapMs, reason) => {
      lastTickTs = null;
      gapEvent(h, name, gapMs, reason);
    },
    onMessage: normalize,
  });
}

export function createBinanceFeed(cfg: Config, h: FeedHooks): ResilientWs {
  const name = "spot:binance";
  const s = cfg.spot.symbol.binance;
  return new ResilientWs({
    name,
    url: `${cfg.spot.binanceWsUrl}?streams=${s}@bookTicker/${s}@aggTrade`,
    silenceMs: cfg.recorder.silenceMs.binance,
    now: h.now,
    onOpen: () => {},
    onStateChange: (c, d) => h.onState(name, c, d),
    onGap: (gapMs, reason) => gapEvent(h, name, gapMs, reason),
    onMessage: handler(h, name, (raw, recvTs) => normalizeBinance(raw, recvTs, h.now())),
  });
}

export function createCoinbaseFeed(cfg: Config, h: FeedHooks): ResilientWs {
  const name = "spot:coinbase";
  const product = cfg.spot.symbol.coinbase;
  return new ResilientWs({
    name,
    url: cfg.spot.coinbaseWsUrl,
    silenceMs: cfg.recorder.silenceMs.coinbase,
    now: h.now,
    // heartbeat (1/s) keeps the watchdog honest during quiet periods; it is not recorded
    onOpen: (send) => send(JSON.stringify({ type: "subscribe", product_ids: [product], channels: ["ticker", "heartbeat"] })),
    onStateChange: (c, d) => h.onState(name, c, d),
    onGap: (gapMs, reason) => gapEvent(h, name, gapMs, reason),
    onMessage: handler(h, name, normalizeCoinbase),
  });
}
