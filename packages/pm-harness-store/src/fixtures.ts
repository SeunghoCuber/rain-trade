// Synthetic event streams for tests.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { encodeEvent, loadConfig, type Config, type MarketEvent } from "@rain/pm-harness-core";

export const W0 = Date.parse("2026-09-24T21:15:00Z");
export const MID = "0xabc";

export function testConfig(dataDir: string): Config {
  const cfg = loadConfig(new URL("../../../config/default.yaml", import.meta.url).pathname);
  return { ...cfg, recorder: { ...cfg.recorder, dataDir } };
}

const ns = (ms: number) => BigInt(ms) * 1_000_000n;

export interface MarketOpts {
  windowStart?: number;
  /** Chainlink price before / after the window midpoint: p1 > p0 → UP */
  p0?: number;
  p1?: number;
  /** recv-time ranges [from, to) during which nothing at all is recorded */
  holes?: [number, number][];
  /** first book event only after this many ms into the window */
  joinLateMs?: number;
  resolution?: { outcome: "UP" | "DOWN"; priceToBeat?: number; finalPrice?: number } | null;
}

/** One fully-recorded 15 min market: open, book deltas every 500 ms, binance every 250 ms, 1 s Chainlink ticks, close, resolution. */
export function marketEvents(o: MarketOpts = {}): MarketEvent[] {
  const ws = o.windowStart ?? W0;
  const we = ws + 900_000;
  const p0 = o.p0 ?? 84_000;
  const p1 = o.p1 ?? 84_010;
  const inHole = (t: number) => (o.holes ?? []).some(([a, b]) => t >= a && t < b);
  const evs: MarketEvent[] = [];
  const push = (t: number, e: Omit<MarketEvent, "recvTs">) => {
    if (!inHole(t)) evs.push({ ...e, recvTs: ns(t) } as MarketEvent);
  };
  push(ws - 90_000, {
    kind: "market_open",
    marketId: MID,
    exchangeTs: ws - 90_000,
    payload: {
      slug: `btc-updown-15m-${ws / 1000}`,
      upTokenId: "up",
      downTokenId: "down",
      windowStart: ws,
      windowEnd: we,
      tickSize: 0.01,
      minOrderSize: 5,
      feeSchedule: { rate: 0.07, exponent: 1, takerOnly: true, rebateRate: 0.2 },
    },
  });
  const priceAt = (t: number) => (t < ws + 450_000 ? p0 : p1);
  for (let t = ws - 89_000; t <= we + 4_000; t += 250) {
    push(t, { kind: "spot", exchangeTs: t, payload: { type: "bbo", source: "binance", bid: 84_000, bidSize: 1, ask: 84_000.01, askSize: 1 } });
    if (t % 1000 === 0) {
      push(t + 1, { kind: "res_price", exchangeTs: t, payload: { source: "chainlink", symbol: "btc/usd", price: priceAt(t), scaled: (BigInt(priceAt(t)) * 10n ** 18n).toString() } });
    }
    if (t % 500 === 0 && t >= ws - 89_000 + (o.joinLateMs !== undefined ? 89_000 + o.joinLateMs : 0)) {
      push(t + 2, {
        kind: "book_delta",
        marketId: MID,
        exchangeTs: t,
        payload: { changes: [{ token: "UP", side: "BUY", price: 0.5, size: (t / 500) % 100, bestBid: 0.5, bestAsk: 0.51 }] },
      });
    }
  }
  push(we, { kind: "market_close", marketId: MID, exchangeTs: we, payload: { windowEnd: we } });
  if (o.resolution !== null) {
    const r = o.resolution ?? { outcome: p1 >= p0 ? "UP" : "DOWN" };
    push(we + 5_000, {
      kind: "resolution",
      marketId: MID,
      exchangeTs: we + 5_000,
      payload: { outcome: r.outcome, priceToBeat: r.priceToBeat ?? p0, finalPrice: r.finalPrice ?? p1 },
    });
  }
  return evs.sort((a, b) => (a.recvTs < b.recvTs ? -1 : a.recvTs > b.recvTs ? 1 : 0));
}

/** Write events into the recorder's raw layout (one file per UTC hour). */
export function writeRaw(dataDir: string, evs: MarketEvent[], opts: { gzip?: boolean; extraLines?: string[] } = {}): string[] {
  const byFile = new Map<string, string[]>();
  for (const e of evs) {
    const iso = new Date(Number(e.recvTs / 1_000_000n)).toISOString();
    const f = join(dataDir, "raw", iso.slice(0, 10), `${iso.slice(11, 13)}.ndjson${opts.gzip === false ? "" : ".gz"}`);
    (byFile.get(f) ?? byFile.set(f, []).get(f)!).push(encodeEvent(e));
  }
  for (const [f, lines] of byFile) {
    const body = [...lines, ...(opts.extraLines ?? [])].join("\n") + "\n";
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, f.endsWith(".gz") ? gzipSync(body) : body);
  }
  return [...byFile.keys()];
}
