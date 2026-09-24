import { MarketEvent } from "./events.ts";

// NDJSON cannot carry bigint, so recvTs is written as a decimal string.

export function encodeEvent(ev: MarketEvent): string {
  return JSON.stringify(ev, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

export function decodeEvent(line: string): MarketEvent {
  const raw = JSON.parse(line) as { recvTs?: unknown };
  if (typeof raw.recvTs === "string") raw.recvTs = BigInt(raw.recvTs);
  return MarketEvent.parse(raw);
}
