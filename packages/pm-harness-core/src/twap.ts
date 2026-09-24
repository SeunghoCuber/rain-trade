/** A Chainlink tick as relayed by RTDS: whole-second timestamp and price scaled by 1e18. */
export interface ChainlinkTick {
  timestampMs: number;
  /** `full_accuracy_value`: price * 1e18 as an integer */
  scaled: bigint;
}

/** Inclusive tick window relative to the boundary, in seconds. Verified: [-62, -3] (docs/VERIFIED.md §2.1). */
export interface TwapWindow {
  fromSec: number;
  toSec: number;
}

export interface TwapResult {
  price: number;
  /** ticks used; the verified window expects toSec - fromSec + 1 */
  count: number;
  expected: number;
}

const SCALE = 10n ** 18n;

/** Reference price at a window boundary: simple mean of the Chainlink ticks inside `window`. */
export function chainlinkTwap(ticks: Iterable<ChainlinkTick>, boundaryMs: number, window: TwapWindow): TwapResult | null {
  const lo = boundaryMs + window.fromSec * 1000;
  const hi = boundaryMs + window.toSec * 1000;
  const seen = new Set<number>();
  let sum = 0n;
  for (const t of ticks) {
    if (t.timestampMs < lo || t.timestampMs > hi || seen.has(t.timestampMs)) continue;
    seen.add(t.timestampMs);
    sum += t.scaled;
  }
  const count = seen.size;
  if (count === 0) return null;
  // integer part and fraction kept separate so the division stays exact to ~1e-12
  const q = sum / BigInt(count);
  const price = Number(q / SCALE) + Number(q % SCALE) / 1e18;
  return { price, count, expected: window.toSec - window.fromSec + 1 };
}
