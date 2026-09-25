import type { MarketEvent } from "@rain/pm-harness-core";
import { describe, expect, it } from "vitest";
import { Discovery } from "../discovery.ts";
import { parseMarketInfo, parseResolution, slugFor, windowStartOf, type GammaEvent, type MarketInfo } from "../gamma.ts";
import { sampleJson } from "./samples.ts";

const current = sampleJson<GammaEvent[]>("gamma-event-current.json")[0]!;
const resolved = sampleJson<GammaEvent[]>("gamma-event-resolved.json")[0]!;

describe("gamma parsing", () => {
  it("parses the window from startTime/endDate, not the ~24h-early startDate", () => {
    const m = parseMarketInfo(current, 900);
    expect(m.slug).toBe("btc-updown-15m-1790283600");
    expect(m.windowStart).toBe(1790283600_000);
    expect(m.windowEnd - m.windowStart).toBe(900_000);
    expect(m.feeSchedule).toEqual({ rate: 0.07, exponent: 1, takerOnly: true, rebateRate: 0.2 });
    expect(m.upTokenId.startsWith("5512")).toBe(true);
  });

  it("reads the official resolution only once closed with both reference prices", () => {
    expect(parseResolution(current)).toBeNull();
    expect(parseResolution(resolved)).toEqual({ outcome: "DOWN", priceToBeat: 84353.97077358236, finalPrice: 84274.80743404676 });
  });

  it("builds deterministic slugs", () => {
    expect(windowStartOf(1790284047938, 900)).toBe(1790283600_000);
    expect(slugFor("btc-updown-15m", 1790283600_000)).toBe("btc-updown-15m-1790283600");
  });
});

/** Fake Gamma that serves `current` re-stamped for any requested window. */
function fakeGamma(resolvedWindows: Set<number>) {
  const calls: string[] = [];
  const fetchJson = async (url: string) => {
    calls.push(url);
    const ws = Number(/-(\d+)$/.exec(decodeURIComponent(url))![1]) * 1000;
    const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
    const e = structuredClone(current);
    e.slug = slugFor("btc-updown-15m", ws);
    e.startTime = iso(ws);
    e.endDate = iso(ws + 900_000);
    e.markets[0]!.endDate = e.endDate;
    e.markets[0]!.conditionId = `0x${ws}`;
    if (resolvedWindows.has(ws)) {
      e.markets[0]!.closed = true;
      e.markets[0]!.outcomePrices = '["1", "0"]';
      e.eventMetadata = { priceToBeat: 100, finalPrice: 101 };
    }
    return [e];
  };
  return { fetchJson, calls };
}

function setup(startMs: number, resolvedWindows = new Set<number>()) {
  let now = startMs;
  const events: MarketEvent[] = [];
  const opened: MarketInfo[] = [];
  const retired: MarketInfo[] = [];
  const gamma = fakeGamma(resolvedWindows);
  const d = new Discovery({
    gammaUrl: "https://gamma.test",
    slugPrefix: "btc-updown-15m",
    durationSec: 900,
    discoveryPollSec: 30,
    preRegisterSec: 60,
    postCloseGraceSec: 5,
    resolutionGiveUpSec: 7200,
    fetchJson: gamma.fetchJson,
    emit: (e) => events.push(e),
    recvTs: () => BigInt(now) * 1_000_000n,
    now: () => now,
    onOpen: (m) => opened.push(m),
    onRetire: (m) => retired.push(m),
    log: () => {},
  });
  return { d, events, opened, retired, gamma, setNow: (t: number) => (now = t) };
}

const W = 1790283600_000; // a window start

describe("Discovery", () => {
  it("registers the live window on start and the next one ≥ preRegisterSec before open", async () => {
    const s = setup(W + 60_000);
    await s.d.refresh();
    expect(s.opened.map((m) => m.windowStart)).toEqual([W]);

    s.setNow(W + 900_000 - 91_000); // just outside preRegister + poll horizon
    await s.d.refresh();
    expect(s.opened).toHaveLength(1);

    s.setNow(W + 900_000 - 89_000); // this poll is the last one ≥ 60 s before open
    await s.d.refresh();
    expect(s.opened.map((m) => m.windowStart)).toEqual([W, W + 900_000]);
    expect(s.events.filter((e) => e.kind === "market_open")).toHaveLength(2);
  });

  it("does not re-register a known market", async () => {
    const s = setup(W + 1000);
    await s.d.refresh();
    await s.d.refresh();
    expect(s.gamma.calls).toHaveLength(1);
  });

  it("emits market_close at windowEnd, retires after grace, then polls until resolved", async () => {
    const resolvedSet = new Set<number>();
    const s = setup(W + 1000, resolvedSet);
    await s.d.refresh();

    s.setNow(W + 900_000 - 1);
    s.d.tick();
    expect(s.events.some((e) => e.kind === "market_close")).toBe(false);

    s.setNow(W + 900_000);
    s.d.tick();
    const close = s.events.find((e) => e.kind === "market_close")!;
    expect(close).toMatchObject({ marketId: `0x${W}`, exchangeTs: W + 900_000 });
    expect(s.retired).toHaveLength(0);

    s.setNow(W + 905_000);
    s.d.tick();
    expect(s.retired.map((m) => m.windowStart)).toEqual([W]);

    await s.d.refresh(); // not yet resolved
    expect(s.events.some((e) => e.kind === "resolution")).toBe(false);
    expect(s.d.pendingResolutions).toBe(1);

    resolvedSet.add(W);
    await s.d.refresh();
    const res = s.events.find((e) => e.kind === "resolution")!;
    expect(res).toMatchObject({ marketId: `0x${W}`, payload: { outcome: "UP", priceToBeat: 100, finalPrice: 101 } });
    expect(s.d.pendingResolutions).toBe(0);
  });

  it("seeds resolutions for windows that closed before a restart and gives up after the limit", async () => {
    const s = setup(W + 1000);
    s.d.seedRecentResolutions();
    expect(s.d.pendingResolutions).toBe(8); // 2 h of 15 min windows
    s.setNow(W + 1000 + 7200_000 + 900_000);
    await s.d.refresh();
    expect(s.d.pendingResolutions).toBeLessThan(8);
  });

  it("survives Gamma errors and retries on the next refresh", async () => {
    const s = setup(W + 1000);
    let fail = true;
    const orig = s.gamma.fetchJson;
    (s.d as unknown as { o: { fetchJson: typeof orig } }).o.fetchJson = async (u) => {
      if (fail) throw new Error("HTTP 503");
      return orig(u);
    };
    await s.d.refresh();
    expect(s.opened).toHaveLength(0);
    fail = false;
    await s.d.refresh();
    expect(s.opened).toHaveLength(1);
  });
});
