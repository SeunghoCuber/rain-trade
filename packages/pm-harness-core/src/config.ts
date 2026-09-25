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
    /** |our TWAP − Gamma reference| above this (USD) is flagged TWAPΔ; RTDS is only accurate to ~$0.7 (VERIFIED.md §2.1) */
    twapToleranceUsd: z.number().nonnegative(),
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
    /** macOS: hold a `caffeinate -is` assertion for the recorder's lifetime (no idle sleep; no system sleep on AC) */
    preventSleep: z.boolean(),
    /** POST {text} here on feed silence/recovery (Slack/ntfy/etc.); null disables */
    alertWebhookUrl: z.url().nullable(),
  }),
  fairValue: z.object({
    /** EWMA half-lives of 1 s log-return variance; the variances are averaged */
    volHalfLivesSec: z.array(z.number().positive()).min(1),
    /** spot_mid: Binance/Coinbase mid shifted onto the Chainlink level by a tracked basis; res_price: latest Chainlink tick */
    spotInput: z.enum(["spot_mid", "res_price"]),
    /** prior per-second log vol until the EWMAs warm up (BTC ≈ 50%/yr ≈ 9e-5 /√s) */
    initSigmaPerSec: z.number().positive(),
    /** EWMA half-life of ln(Chainlink / spot mid) */
    basisHalfLifeSec: z.number().positive(),
    /** spot feed older than this falls back to the next source (Binance → Coinbase → Chainlink) */
    spotStaleMs: z.number().positive(),
    /** sd (USD) for our TWAP / S0 vs the official reference (RTDS reproduces it to ≤ ~$0.7, median ~$0.05) */
    twapNoiseUsd: z.number().nonnegative(),
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
    /** after a spot jump, stay out this long */
    jumpCooldownMs: z.number().nonnegative(),
    /**
     * the inventory cap shrinks linearly to 0 over this many seconds before the pull; above the
     * shrinking cap only the reducing side is quoted, at FV + unwindEdge, to arrive flat at
     * settlement (0 = the cap stays at maxInventory until the pull)
     */
    inventoryDecaySec: z.number().nonnegative(),
    /** reducing quote while over the cap: FV − unwindEdge for a bid, FV + unwindEdge for an ask */
    unwindEdge: z.number().nonnegative(),
    /** outside [lo, hi] fair value, never add to a position (only reduce): the outcome is nearly decided */
    fvBand: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
    /** vol term = |FV(S·e^{σ√h}) − FV(S)| over this horizon h, times volSpreadMult (PLAN's σ√τ in probability units) */
    volHorizonSec: z.number().positive(),
  }),
  sim: z.object({
    seed: z.number().int(),
    modes: z.object({ optimistic: FillModeParams, base: FillModeParams, pessimistic: FillModeParams }),
  }),
  /** go/no-go thresholds (PLAN.md §10), evaluated on out-of-sample pessimistic results */
  report: z.object({
    minMarkets: z.number().int().positive(),
    minDays: z.number().positive(),
    minTStat: z.number(),
    /** planned bankroll; max drawdown must stay below maxDrawdownFrac of it */
    bankrollUsd: z.number().positive(),
    maxDrawdownFrac: z.number().positive(),
    /** chosen config's grid neighbours must be within this fraction of its in-sample edge */
    plateauFrac: z.number().positive(),
    /** FV Brier may be at most this fraction worse than the Polymarket mid's */
    brierTolerance: z.number().nonnegative(),
    /** in-sample share of the data (by day; by market while there are fewer than 5 days) */
    inSampleFrac: z.number().min(0.1).max(0.9),
  }),
  dashboard: z.object({
    /** IANA zone for every time shown in the dashboard (daylight saving handled automatically) */
    timeZone: z.string(),
  }),
  /** live paper trading (Phase 11) */
  live: z.object({
    outDir: z.string(),
    /** fill modes to run live */
    modes: z.array(z.enum(["optimistic", "base", "pessimistic"])).min(1),
    statusIntervalSec: z.number().positive(),
    killSwitch: z.object({
      /** stop quoting when cumulative pessimistic PnL falls this far below its peak */
      maxDrawdownUsd: z.number().positive(),
      /** stop quoting when the rolling 7-day pessimistic edge (¢/share) drops below this, once minMarkets are in */
      minRolling7dEdgeCents: z.number(),
      minMarkets: z.number().int().positive(),
    }),
  }),
});
export type Config = z.infer<typeof Config>;

export function loadConfig(path: string): Config {
  return Config.parse(parse(readFileSync(path, "utf8")));
}
