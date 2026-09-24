import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chainlinkTwap, type ChainlinkTick } from "./twap.ts";

interface Fixture {
  boundaryMs: number;
  officialFinalPrice: string;
  ticks: [number, string][];
}

const fx = JSON.parse(
  readFileSync(new URL("./fixtures/twap-boundary-1790284500.json", import.meta.url), "utf8"),
) as Fixture;
const ticks: ChainlinkTick[] = fx.ticks.map(([timestampMs, v]) => ({ timestampMs, scaled: BigInt(v) }));

describe("chainlinkTwap", () => {
  it("reproduces the official 21:15 UTC boundary price with the verified window", () => {
    const r = chainlinkTwap(ticks, fx.boundaryMs, { fromSec: -62, toSec: -3 });
    expect(r?.count).toBe(60);
    expect(r?.expected).toBe(60);
    expect(Math.abs(r!.price - Number(fx.officialFinalPrice))).toBeLessThan(1e-9);
  });

  it("does not match with the naive [B-60, B] window", () => {
    const r = chainlinkTwap(ticks, fx.boundaryMs, { fromSec: -60, toSec: 0 });
    expect(Math.abs(r!.price - Number(fx.officialFinalPrice))).toBeGreaterThan(0.1);
  });

  it("reports missing ticks and ignores duplicates", () => {
    const gappy = [...ticks.filter((t) => t.timestampMs !== fx.boundaryMs - 10_000), ticks[20]!];
    const r = chainlinkTwap(gappy, fx.boundaryMs, { fromSec: -62, toSec: -3 });
    expect(r?.count).toBe(59);
  });

  it("returns null with no ticks in range", () => {
    expect(chainlinkTwap([], fx.boundaryMs, { fromSec: -62, toSec: -3 })).toBeNull();
  });
});
