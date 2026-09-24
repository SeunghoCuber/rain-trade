import { z } from "zod";

// Shapes below are derived from raw samples in docs/samples/ (see docs/VERIFIED.md).

export const Side = z.enum(["BUY", "SELL"]);
export type Side = z.infer<typeof Side>;

export const Token = z.enum(["UP", "DOWN"]);
export type Token = z.infer<typeof Token>;

export const FillMode = z.enum(["optimistic", "base", "pessimistic"]);
export type FillMode = z.infer<typeof FillMode>;

const Price = z.number().min(0).max(1);
const Size = z.number().nonnegative();

export const Level = z.object({ price: Price, size: Size });
export type Level = z.infer<typeof Level>;

/** Full book for one token. Polymarket publishes a unified book: UP bids == DOWN asks at 1-p. */
export const BookSnapshotPayload = z.object({
  bids: z.array(Level),
  asks: z.array(Level),
  hash: z.string(),
});

/**
 * One price-level update. `size` is the new total resting size at that level (0 = level removed).
 * The CLOB WS sends every change as a mirrored UP/DOWN pair; the recorder keeps both.
 */
export const LevelChange = z.object({
  token: Token,
  side: Side,
  price: Price,
  size: Size,
  bestBid: Price.nullable(),
  bestAsk: Price.nullable(),
});
export type LevelChange = z.infer<typeof LevelChange>;

export const BookDeltaPayload = z.object({ changes: z.array(LevelChange).min(1) });

/**
 * A trade print. Each match is published once, on the taker's token only, and `side` is the
 * taker's side (e.g. DOWN BUY @0.70 lifts the DOWN ask == hits the UP bid at 0.30).
 */
export const TradePayload = z.object({
  price: Price,
  size: z.number().positive(),
  side: Side,
  feeRateBps: z.number().nonnegative(),
  txHash: z.string(),
});

export const SpotSource = z.enum(["binance", "coinbase"]);

export const SpotPayload = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("bbo"),
    source: SpotSource,
    bid: z.number().positive(),
    bidSize: z.number().nonnegative(),
    ask: z.number().positive(),
    askSize: z.number().nonnegative(),
  }),
  z.object({
    type: z.literal("trade"),
    source: SpotSource,
    price: z.number().positive(),
    size: z.number().positive(),
    side: Side,
  }),
]);

/** Chainlink BTC/USD price as relayed by Polymarket RTDS (`crypto_prices_chainlink`). */
export const ResPricePayload = z.object({
  source: z.literal("chainlink"),
  symbol: z.string(),
  price: z.number().positive(),
  /** `full_accuracy_value` (price * 1e18); settlement TWAP is computed from this, not `price` */
  scaled: z.string().regex(/^\d+$/),
});

export const FeeSchedule = z.object({
  rate: z.number().nonnegative(),
  exponent: z.number().nonnegative(),
  takerOnly: z.boolean(),
  rebateRate: z.number().min(0).max(1),
});
export type FeeSchedule = z.infer<typeof FeeSchedule>;

export const MarketOpenPayload = z.object({
  slug: z.string(),
  upTokenId: z.string(),
  downTokenId: z.string(),
  windowStart: z.number().int(),
  windowEnd: z.number().int(),
  tickSize: z.number().positive(),
  minOrderSize: z.number().positive(),
  feeSchedule: FeeSchedule,
});

export const MarketClosePayload = z.object({ windowEnd: z.number().int() });

export const ResolutionPayload = z.object({
  outcome: Token,
  priceToBeat: z.number().positive(),
  finalPrice: z.number().positive(),
});

export const FeedGapPayload = z.object({
  feed: z.string(),
  gapMs: z.number().nonnegative(),
  reason: z.enum(["reconnect", "silence", "sequence_break"]),
});

const base = {
  marketId: z.string().optional(),
  token: Token.optional(),
  /** ms, from the source */
  exchangeTs: z.number(),
  /** ns, local monotonic clock */
  recvTs: z.bigint(),
};

export const MarketEvent = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("book_snapshot"), payload: BookSnapshotPayload }),
  z.object({ ...base, kind: z.literal("book_delta"), payload: BookDeltaPayload }),
  z.object({ ...base, kind: z.literal("trade"), payload: TradePayload }),
  z.object({ ...base, kind: z.literal("spot"), payload: SpotPayload }),
  z.object({ ...base, kind: z.literal("res_price"), payload: ResPricePayload }),
  z.object({ ...base, kind: z.literal("market_open"), payload: MarketOpenPayload }),
  z.object({ ...base, kind: z.literal("market_close"), payload: MarketClosePayload }),
  z.object({ ...base, kind: z.literal("resolution"), payload: ResolutionPayload }),
  z.object({ ...base, kind: z.literal("feed_gap"), payload: FeedGapPayload }),
]);
export type MarketEvent = z.infer<typeof MarketEvent>;
export type MarketEventKind = MarketEvent["kind"];
export type EventOf<K extends MarketEventKind> = Extract<MarketEvent, { kind: K }>;
