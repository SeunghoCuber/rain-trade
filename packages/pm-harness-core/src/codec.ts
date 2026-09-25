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

/**
 * Key-order-independent encoding for digests and equality checks. Events built by different paths
 * (raw decode, Parquet replay, live normalizers) carry the same fields in different key orders.
 */
export function canonicalEvent(ev: MarketEvent): string {
  return JSON.stringify(sortKeys(ev));
}

function sortKeys(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort()
        .map((k) => [k, sortKeys(o[k])]),
    );
  }
  return v;
}
