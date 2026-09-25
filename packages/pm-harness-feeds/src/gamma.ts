import { FeeSchedule, type Token } from "@rain/pm-harness-core";

// Gamma /events?slug=... response (docs/samples/gamma-event-*.json). Only fields we rely on.

interface GammaMarket {
  conditionId: string;
  slug: string;
  clobTokenIds: string;
  outcomes: string;
  outcomePrices: string;
  eventStartTime?: string;
  endDate: string;
  closed: boolean;
  orderPriceMinTickSize: number;
  orderMinSize: number;
  feeSchedule?: unknown;
}

export interface GammaEvent {
  slug: string;
  startTime?: string;
  endDate: string;
  closed: boolean;
  markets: GammaMarket[];
  eventMetadata?: { priceToBeat?: number; finalPrice?: number } | null;
}

export interface MarketInfo {
  marketId: string;
  slug: string;
  upTokenId: string;
  downTokenId: string;
  windowStart: number;
  windowEnd: number;
  tickSize: number;
  minOrderSize: number;
  feeSchedule: FeeSchedule;
}

export interface Resolution {
  outcome: Token;
  priceToBeat: number;
  finalPrice: number;
}

export const slugFor = (prefix: string, windowStartMs: number) => `${prefix}-${windowStartMs / 1000}`;

/** Window start (ms) of the window containing `ms`. */
export const windowStartOf = (ms: number, durationSec: number) => ms - (ms % (durationSec * 1000));

export function parseMarketInfo(ev: GammaEvent, durationSec: number): MarketInfo {
  const m = ev.markets[0];
  if (!m) throw new Error(`${ev.slug}: event has no markets`);
  const outcomes = JSON.parse(m.outcomes) as string[];
  const tokens = JSON.parse(m.clobTokenIds) as string[];
  if (outcomes[0] !== "Up" || outcomes[1] !== "Down" || tokens.length !== 2) {
    throw new Error(`${ev.slug}: unexpected outcomes ${m.outcomes}`);
  }
  // startDate is the creation time (~24 h early); the window is startTime/eventStartTime → endDate.
  const start = ev.startTime ?? m.eventStartTime;
  if (!start) throw new Error(`${ev.slug}: no window start`);
  const windowStart = Date.parse(start);
  const windowEnd = Date.parse(m.endDate);
  if (windowEnd - windowStart !== durationSec * 1000) {
    throw new Error(`${ev.slug}: window ${start}..${m.endDate} is not ${durationSec}s`);
  }
  return {
    marketId: m.conditionId,
    slug: ev.slug,
    upTokenId: tokens[0]!,
    downTokenId: tokens[1]!,
    windowStart,
    windowEnd,
    tickSize: m.orderPriceMinTickSize,
    minOrderSize: m.orderMinSize,
    feeSchedule: FeeSchedule.parse(m.feeSchedule),
  };
}

/** Official outcome once Gamma has both reference prices and settled outcomePrices; null until then. */
export function parseResolution(ev: GammaEvent): Resolution | null {
  const m = ev.markets[0];
  const md = ev.eventMetadata;
  if (!m?.closed || md?.priceToBeat == null || md.finalPrice == null) return null;
  const prices = JSON.parse(m.outcomePrices) as string[];
  const outcome: Token | null = prices[0] === "1" && prices[1] === "0" ? "UP" : prices[0] === "0" && prices[1] === "1" ? "DOWN" : null;
  if (!outcome) return null;
  return { outcome, priceToBeat: md.priceToBeat, finalPrice: md.finalPrice };
}

export type FetchJson = (url: string) => Promise<unknown>;

export const defaultFetchJson: FetchJson = async (url) => {
  const res = await fetch(url, { headers: { "User-Agent": "raintrade-recorder" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res.json();
};

export async function fetchEvent(fetchJson: FetchJson, gammaUrl: string, slug: string): Promise<GammaEvent | null> {
  const body = (await fetchJson(`${gammaUrl}/events?slug=${encodeURIComponent(slug)}`)) as GammaEvent[];
  return body[0] ?? null;
}
