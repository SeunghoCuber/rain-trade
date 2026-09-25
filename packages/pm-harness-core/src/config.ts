import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { FeeSchedule } from "./events.ts";

const FillModeParams = z.object({
  ackLatencyMs: z.number().nonnegative(),
  cancelLatencyMs: z.number().nonnegative(),
  /** extra queue added on arrival, as a fraction of displayed size (pessimistic: 0.1) */
  queuePadFrac: z.number().nonnegative(),
  /** fraction of cancels at our level assumed to be ahead of us (optimistic: pro-rata, base: 0.5, pessimistic: 0) */
  cancelsAheadFrac: z.union([z.literal("prorata"), z.number().min(0).max(1)]),
});

export const Config = z.object({
  market: z.object({
    coin: z.string(),
    /** window length in seconds */
    durationSec: z.number().int().positive(),
    /** Gamma event slug prefix; full slug is `${slugPrefix}-${windowStartUnixSec}` */
    slugPrefix: z.string(),
  }),
  venue: z.object({
    gammaUrl: z.url(),
    clobUrl: z.url(),
    clobWsUrl: z.url(),
    rtdsWsUrl: z.url(),
    tickSize: z.number().positive(),
    minOrderSize: z.number().positive(),
    feeSchedule: FeeSchedule,
    /** Books are unified (UP bid p == DOWN ask 1-p), so DOWN trades also consume UP queues. */
    complementaryMatching: z.boolean(),
  }),
  spot: z.object({
    /** api/stream.binance.com is geo-blocked (HTTP 451) from US; the market-data mirror is not. */
    binanceWsUrl: z.url(),
    coinbaseWsUrl: z.url(),
    symbol: z.object({ binance: z.string(), coinbase: z.string() }),
  }),
  settlement: z.object({
    /** "up": Up wins when final >= priceToBeat (ties go to Up) */
    tieGoesTo: z.enum(["up", "down"]),
    /** Inclusive Chainlink tick window around each boundary, in seconds (verified [-62, -3]) */
    twapWindow: z.object({ fromSec: z.number().int(), toSec: z.number().int() }),
    mergePairs: z.boolean(),
  }),
  recorder: z.object({
    dataDir: z.string(),
    discoveryPollSec: z.number().positive(),
    preRegisterSec: z.number().nonnegative(),
    /** keep the CLOB connection open this long after windowEnd */
    postCloseGraceSec: z.number().nonnegative(),
    /** stop polling Gamma for a resolution after this long past windowEnd */
    resolutionGiveUpSec: z.number().positive(),
    /** a market with any feed gap longer than this is excluded from headline stats */
    maxGapMs: z.number().positive(),
    /** reconnect a feed after this much silence (includes PONGs / heartbeats) */
    silenceMs: z.object({
      clob: z.number().positive(),
      rtds: z.number().positive(),
      binance: z.number().positive(),
      coinbase: z.number().positive(),
    }),
    /** store only the UP side of mirrored UP/DOWN book updates (DOWN = mirror); ~10x smaller */
    dropMirrored: z.boolean(),
    spotSources: z.array(z.enum(["binance", "coinbase"])).min(1),
    statusIntervalSec: z.number().positive(),
    /** POST {text} here on feed silence/recovery (Slack/ntfy/etc.); null disables */
    alertWebhookUrl: z.url().nullable(),
  }),
  fairValue: z.object({
    volHalfLivesSec: z.array(z.number().positive()).min(1),
    spotInput: z.enum(["spot_mid", "res_price"]),
  }),
  strategy: z.object({
    halfSpread: z.number().nonnegative(),
    volSpreadMult: z.number().nonnegative(),
    skewPerShare: z.number().nonnegative(),
    maxInventory: z.number().positive(),
    quoteSize: z.number().positive(),
    requoteThreshold: z.number().nonnegative(),
    pullBeforeCloseSec: z.number().nonnegative(),
    pullOnSpotJump: z.object({ bp: z.number().positive(), windowMs: z.number().positive() }),
  }),
  sim: z.object({
    seed: z.number().int(),
    modes: z.object({ optimistic: FillModeParams, base: FillModeParams, pessimistic: FillModeParams }),
  }),
});
export type Config = z.infer<typeof Config>;

export function loadConfig(path: string): Config {
  return Config.parse(parse(readFileSync(path, "utf8")));
}
