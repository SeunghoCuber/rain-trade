import { loadConfig, Rng, type MarketEvent } from "@rain/pm-harness-core";
import { describe, expect, it } from "vitest";
import { BasisTracker, FairValueEngine, priceClosingTwap, VolEstimator } from "./fair-value.ts";
import { normCdf } from "./math.ts";

const cfg = loadConfig(new URL("../../../config/default.yaml", import.meta.url).pathname);
const E = Date.parse("2026-09-25T01:15:00Z");
const base = { s0: 84_000, sigma: 1e-4, windowEnd: E, winFromSec: -62, winToSec: -3, noiseUsd: 0 };

describe("normCdf", () => {
  it("matches reference values", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 7);
    expect(normCdf(1.959964)).toBeCloseTo(0.975, 6);
    expect(normCdf(-3)).toBeCloseTo(0.0013499, 6);
  });
});

describe("priceClosingTwap", () => {
  it("is 0.5 at the money and moves with the price", () => {
    const now = E - 600_000;
    const atm = priceClosingTwap({ ...base, nowMs: now, s: 84_000, observed: () => undefined });
    expect(atm.p).toBeCloseTo(0.5, 7);
    const up = priceClosingTwap({ ...base, nowMs: now, s: 84_050, observed: () => undefined });
    expect(up.p).toBeGreaterThan(0.55);
  });

  it("reduces to the plain digital with τ_eff = time to window + L/3 far from expiry", () => {
    const now = E - 600_000;
    const s = 84_030;
    const fv = priceClosingTwap({ ...base, nowMs: now, s, observed: () => undefined });
    const tauEff = (E - 62_000 - now) / 1000 + 59 / 3 + 0.5; // discrete 60-point average ≈ L/3 + ½ step
    const plain = normCdf((s - base.s0) / (s * base.sigma * Math.sqrt(tauEff)));
    expect(fv.p).toBeCloseTo(plain, 2);
  });

  it("uses observed ticks inside the averaging window and becomes certain once all are in", () => {
    const within = E - 30_000; // ticks at −62…−30 s observed: 33 of 60
    const obs = (t: number) => (t <= within ? 84_100 : undefined);
    const fv = priceClosingTwap({ ...base, nowMs: within, s: 84_000, observed: obs });
    expect(fv.mean).toBeCloseTo((33 * 84_100 + 27 * 84_000) / 60, 6);
    expect(fv.p).toBeGreaterThan(0.99);
    const done = priceClosingTwap({ ...base, nowMs: E, s: 70_000, observed: () => 84_100 });
    expect(done.p).toBe(1);
    const doneNoisy = priceClosingTwap({ ...base, noiseUsd: 0.2, nowMs: E, s: 70_000, observed: () => 84_000.1 });
    expect(doneNoisy.p).toBeCloseTo(normCdf(0.5), 6);
  });
});

describe("VolEstimator", () => {
  it("recovers the per-second vol of a simulated random walk", () => {
    const v = new VolEstimator([60, 600], 5e-4);
    const r = new Rng(7);
    const gauss = () => Math.sqrt(-2 * Math.log(1 - r.next())) * Math.cos(2 * Math.PI * r.next());
    let p = 84_000;
    for (let s = 0; s < 6_000; s++) {
      p *= Math.exp(1e-4 * gauss());
      v.update(s * 1000 + 500, p);
    }
    expect(v.sigma()).toBeGreaterThan(0.85e-4);
    expect(v.sigma()).toBeLessThan(1.15e-4);
  });

  it("scales a multi-second gap to per-second variance", () => {
    const v = new VolEstimator([1e9], 1e-4); // effectively no decay: prior stays dominant
    v.update(0, 100);
    v.update(1_000, 100);
    v.update(11_000, 100 * Math.exp(1e-4 * Math.sqrt(10)));
    v.update(12_000, 100);
    expect(v.sigma()).toBeCloseTo(1e-4, 6);
  });
});

describe("BasisTracker", () => {
  it("tracks ln(Chainlink / spot) matched on the tick timestamp", () => {
    const b = new BasisTracker(10);
    for (let s = 0; s < 100; s++) {
      b.onSpot(s * 1000 + 200, 84_015); // spot 15 USD above Chainlink
      b.onChainlink(s * 1000, 84_000);
    }
    expect(b.basis).toBeCloseTo(Math.log(84_000 / 84_015), 9);
  });
});

describe("FairValueEngine", () => {
  const ns = (ms: number) => BigInt(ms) * 1_000_000n;
  const W = E - 900_000;
  const events = (): MarketEvent[] => {
    const evs: MarketEvent[] = [
      {
        kind: "market_open",
        marketId: "m",
        exchangeTs: W - 90_000,
        recvTs: ns(W - 90_000),
        payload: { slug: "s", upTokenId: "u", downTokenId: "d", windowStart: W, windowEnd: E, tickSize: 0.01, minOrderSize: 5, feeSchedule: { rate: 0.07, exponent: 1, takerOnly: true, rebateRate: 0.2 } },
      },
    ];
    for (let t = W - 89_000; t <= W + 60_000; t += 250) {
      evs.push({ kind: "spot", exchangeTs: t, recvTs: ns(t), payload: { type: "bbo", source: "binance", bid: 84_014.99, bidSize: 1, ask: 84_015.01, askSize: 1 } });
      if (t % 1000 === 0) evs.push({ kind: "res_price", exchangeTs: t, recvTs: ns(t + 1500), payload: { source: "chainlink", symbol: "btc/usd", price: 84_000 } });
    }
    return evs.sort((a, b) => (a.recvTs < b.recvTs ? -1 : 1));
  };

  it("has no fair value before S0 is known, then prices from the basis-adjusted spot", () => {
    const fv = new FairValueEngine(cfg);
    for (const e of events()) {
      fv.onEvent(e);
      const now = Number(e.recvTs / 1_000_000n);
      if (now < W - 3_000) expect(fv.fairValue("m", now)).toBeNull();
    }
    const v = fv.fairValue("m", W + 60_000)!;
    expect(v.s0).toBeCloseTo(84_000, 6);
    expect(v.s).toBeCloseTo(84_000, 1); // spot 84015 × exp(basis) ≈ Chainlink level
    expect(v.p).toBeCloseTo(0.5, 2);
  });
});
