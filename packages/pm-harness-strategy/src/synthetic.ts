// Synthetic market streams for tests: a random-walk spot, Chainlink ticks trailing it by 1.5 s, a
// Polymarket book centred on a 2-second-stale fair value, takers (half of them informed: they trade
// toward the current fair value the book has not caught up with), and an official resolution
// computed with the verified TWAP rule. Deterministic per seed.
import { Rng, type MarketEvent } from "@rain/pm-harness-core";
import { normCdf } from "./math.ts";

export const SYN_W = Date.parse("2026-09-25T10:00:00Z");
export const SYN_E = SYN_W + 900_000;
const ns = (ms: number) => BigInt(Math.round(ms)) * 1_000_000n;

export function syntheticMarket(seed: number, marketId = "0xsyn"): MarketEvent[] {
  const rng = new Rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rng.next())) * Math.cos(2 * Math.PI * rng.next());
  const sigma = 1.5e-4; // per √s
  const start = SYN_W - 90_000;
  const end = SYN_E + 10_000;
  const S = new Map<number, number>(); // 100 ms grid
  let s = 84_000;
  for (let t = start - 70_000; t <= end; t += 100) {
    s *= Math.exp(sigma * Math.sqrt(0.1) * gauss());
    S.set(t, s);
  }
  const at = (t: number) => S.get(Math.max(start - 70_000, Math.floor(t / 100) * 100))!;
  const twap = (b: number) => {
    let sum = 0;
    for (let i = -62; i <= -3; i++) sum += at(b + i * 1000);
    return sum / 60;
  };
  const s0 = twap(SYN_W);
  const center = (t: number, lagMs = 2_000) => {
    if (t < SYN_W) return 0.5;
    const lag = at(t - lagMs);
    const tau = Math.max(1, (SYN_E - t) / 1000) + 20;
    return Math.min(0.97, Math.max(0.03, normCdf(Math.log(lag / s0) / (sigma * Math.sqrt(tau)))));
  };
  const evs: MarketEvent[] = [];
  evs.push({
    kind: "market_open",
    marketId,
    exchangeTs: start,
    recvTs: ns(start),
    payload: { slug: `btc-updown-15m-${SYN_W / 1000}`, upTokenId: "u", downTokenId: "d", windowStart: SYN_W, windowEnd: SYN_E, tickSize: 0.01, minOrderSize: 5, feeSchedule: { rate: 0.07, exponent: 1, takerOnly: true, rebateRate: 0.2 } },
  });
  let bestBid = 0.49, bestAsk = 0.51;
  for (let t = start - 60_000; t <= end; t += 100) {
    const p = at(t);
    if (t >= start) evs.push({ kind: "spot", exchangeTs: t, recvTs: ns(t), payload: { type: "bbo", source: "binance", bid: p - 0.01, bidSize: 1, ask: p + 0.01, askSize: 1 } });
    if (t % 1000 === 0) evs.push({ kind: "res_price", exchangeTs: t, recvTs: ns(Math.max(start, t + 1_500)), payload: { source: "chainlink", symbol: "btc/usd", price: p } });
    if (t >= start + 1_000 && t % 500 === 0) {
      const c = center(t);
      bestBid = Math.max(0.01, Math.floor((c - 0.005) * 100) / 100);
      bestAsk = Math.min(0.99, bestBid + 0.02);
      const lv = (from: number, dir: number) => Array.from({ length: 5 }, (_, k) => ({ price: +(from + dir * k * 0.01).toFixed(2), size: 100 * (k + 1) })).filter((l) => l.price > 0 && l.price < 1);
      evs.push({ kind: "book_snapshot", marketId, token: "UP", exchangeTs: t, recvTs: ns(t + 1), payload: { bids: lv(bestBid, -1), asks: lv(bestAsk, 1), hash: `h${t}` } });
    }
    if (t >= SYN_W && t < SYN_E && t % 300 === 0) {
      const informed = rng.next() < 0.5;
      const buy = informed ? center(t, 0) > (bestBid + bestAsk) / 2 : rng.next() < 0.5;
      evs.push({ kind: "trade", marketId, token: "UP", exchangeTs: t, recvTs: ns(t + 2), payload: { price: buy ? bestAsk : bestBid, size: 5 + Math.floor(rng.next() * 55), side: buy ? "BUY" : "SELL", feeRateBps: 0, txHash: `t${t}` } });
    }
  }
  evs.push({ kind: "market_close", marketId, exchangeTs: SYN_E, recvTs: ns(SYN_E), payload: { windowEnd: SYN_E } });
  const final = twap(SYN_E);
  evs.push({ kind: "resolution", marketId, exchangeTs: end, recvTs: ns(end), payload: { outcome: final >= s0 ? "UP" : "DOWN", priceToBeat: s0, finalPrice: final } });
  return evs.map((e, i) => ({ e, i })).sort((a, b) => (a.e.recvTs < b.e.recvTs ? -1 : a.e.recvTs > b.e.recvTs ? 1 : a.i - b.i)).map((x) => x.e);
}
