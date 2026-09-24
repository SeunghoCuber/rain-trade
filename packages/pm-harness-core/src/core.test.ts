import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeEvent, encodeEvent, loadConfig, MarketEvent } from "./index.ts";

const defaultConfig = fileURLToPath(new URL("../../../config/default.yaml", import.meta.url));

// Fixtures mirror docs/samples/clob-ws-market.ndjson and rtds.ndjson.
const delta: MarketEvent = {
  kind: "book_delta",
  marketId: "0x1d80359f6b6157014eb5fbdbe4590238415dd9b22bcd52241c0b1a9828c1fbd7",
  exchangeTs: 1790284047938,
  recvTs: 123456789012345678n,
  payload: {
    changes: [
      { token: "UP", side: "BUY", price: 0.31, size: 233, bestBid: 0.31, bestAsk: 0.32 },
      { token: "DOWN", side: "SELL", price: 0.69, size: 233, bestBid: 0.68, bestAsk: 0.69 },
    ],
  },
};

describe("event codec", () => {
  it("round-trips bigint recvTs through NDJSON", () => {
    const line = encodeEvent(delta);
    expect(line).toContain('"recvTs":"123456789012345678"');
    expect(decodeEvent(line)).toEqual(delta);
  });

  it("rejects payloads that do not match their kind", () => {
    const bad = encodeEvent({ ...delta, kind: "trade" } as unknown as MarketEvent);
    expect(() => decodeEvent(bad)).toThrow();
  });

  it("accepts a chainlink res_price event", () => {
    const ev = MarketEvent.parse({
      kind: "res_price",
      exchangeTs: 1790284182000,
      recvTs: 1n,
      payload: { source: "chainlink", symbol: "btc/usd", price: 84338.635, scaled: "84338635000000000000000" },
    });
    expect(ev.kind).toBe("res_price");
  });
});

describe("config", () => {
  it("loads and validates config/default.yaml", () => {
    const cfg = loadConfig(defaultConfig);
    expect(cfg.venue.feeSchedule.rate).toBe(0.07);
    expect(cfg.venue.complementaryMatching).toBe(true);
    expect(cfg.sim.modes.pessimistic.cancelsAheadFrac).toBe(0);
  });
});
