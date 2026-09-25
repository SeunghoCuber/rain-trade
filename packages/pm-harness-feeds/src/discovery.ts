import type { MarketEvent } from "@rain/pm-harness-core";
import {
  fetchEvent,
  parseMarketInfo,
  parseResolution,
  slugFor,
  windowStartOf,
  type FetchJson,
  type MarketInfo,
} from "./gamma.ts";

export interface DiscoveryOptions {
  gammaUrl: string;
  slugPrefix: string;
  durationSec: number;
  discoveryPollSec: number;
  preRegisterSec: number;
  postCloseGraceSec: number;
  resolutionGiveUpSec: number;
  fetchJson: FetchJson;
  emit: (ev: MarketEvent) => void;
  recvTs: () => bigint;
  now: () => number;
  /** market registered: start its CLOB feed */
  onOpen: (m: MarketInfo) => void;
  /** windowEnd + grace passed: stop its CLOB feed */
  onRetire: (m: MarketInfo) => void;
  log: (level: "info" | "warn", msg: string) => void;
}

interface Tracked {
  info: MarketInfo;
  closed: boolean;
}

/**
 * Finds the live and next BTC 15m markets by deterministic slug, emits market_open / market_close,
 * and polls closed markets until Gamma publishes the official resolution.
 */
export class Discovery {
  private readonly markets = new Map<number, Tracked>();
  /** windowStart → give-up time; markets we still need a resolution for */
  private readonly pendingResolution = new Map<number, number>();

  private readonly o: DiscoveryOptions;

  constructor(o: DiscoveryOptions) {
    this.o = o;
  }

  /** Seed resolution polling for markets that closed before we started (we may have recorded them in a previous run). */
  seedRecentResolutions(): void {
    const dur = this.o.durationSec * 1000;
    const now = this.o.now();
    const current = windowStartOf(now, this.o.durationSec);
    for (let ws = current - dur; ws + dur > now - this.o.resolutionGiveUpSec * 1000; ws -= dur) {
      this.pendingResolution.set(ws, ws + dur + this.o.resolutionGiveUpSec * 1000);
    }
  }

  /** Network step: register upcoming markets, poll pending resolutions. Call every discoveryPollSec. */
  async refresh(): Promise<void> {
    const now = this.o.now();
    const dur = this.o.durationSec * 1000;
    // Register any window that starts before the next poll + preRegister horizon and has not ended.
    const horizon = now + (this.o.preRegisterSec + this.o.discoveryPollSec) * 1000;
    for (let ws = windowStartOf(now, this.o.durationSec); ws <= horizon; ws += dur) {
      if (this.markets.has(ws) || ws + dur <= now) continue;
      await this.register(ws);
    }
    for (const [ws, giveUpAt] of [...this.pendingResolution]) {
      if (now > giveUpAt) {
        this.pendingResolution.delete(ws);
        this.o.log("warn", `no resolution for ${slugFor(this.o.slugPrefix, ws)} after ${this.o.resolutionGiveUpSec}s; giving up`);
        continue;
      }
      await this.pollResolution(ws);
    }
  }

  /** Timer step: emit market_close at windowEnd, retire feeds after the grace period. Call often (e.g. 250 ms). */
  tick(): void {
    const now = this.o.now();
    for (const [ws, t] of [...this.markets]) {
      if (!t.closed && now >= t.info.windowEnd) {
        t.closed = true;
        this.o.emit({
          kind: "market_close",
          marketId: t.info.marketId,
          exchangeTs: t.info.windowEnd,
          recvTs: this.o.recvTs(),
          payload: { windowEnd: t.info.windowEnd },
        });
        this.pendingResolution.set(ws, t.info.windowEnd + this.o.resolutionGiveUpSec * 1000);
      }
      if (now >= t.info.windowEnd + this.o.postCloseGraceSec * 1000) {
        this.markets.delete(ws);
        this.o.onRetire(t.info);
      }
    }
  }

  get activeMarkets(): MarketInfo[] {
    return [...this.markets.values()].map((t) => t.info);
  }

  get pendingResolutions(): number {
    return this.pendingResolution.size;
  }

  private async register(ws: number): Promise<void> {
    const slug = slugFor(this.o.slugPrefix, ws);
    try {
      const ev = await fetchEvent(this.o.fetchJson, this.o.gammaUrl, slug);
      if (!ev) {
        this.o.log("warn", `${slug}: not found on Gamma yet`);
        return;
      }
      const info = parseMarketInfo(ev, this.o.durationSec);
      this.markets.set(ws, { info, closed: false });
      this.o.emit({
        kind: "market_open",
        marketId: info.marketId,
        exchangeTs: this.o.now(),
        recvTs: this.o.recvTs(),
        payload: {
          slug: info.slug,
          upTokenId: info.upTokenId,
          downTokenId: info.downTokenId,
          windowStart: info.windowStart,
          windowEnd: info.windowEnd,
          tickSize: info.tickSize,
          minOrderSize: info.minOrderSize,
          feeSchedule: info.feeSchedule,
        },
      });
      this.o.log("info", `registered ${slug} (${info.marketId})`);
      this.o.onOpen(info);
    } catch (err) {
      this.o.log("warn", `${slug}: register failed: ${(err as Error).message}`);
    }
  }

  private async pollResolution(ws: number): Promise<void> {
    const slug = slugFor(this.o.slugPrefix, ws);
    try {
      const ev = await fetchEvent(this.o.fetchJson, this.o.gammaUrl, slug);
      const res = ev && parseResolution(ev);
      if (!ev || !res) return;
      this.pendingResolution.delete(ws);
      this.o.emit({
        kind: "resolution",
        marketId: ev.markets[0]!.conditionId,
        exchangeTs: this.o.now(),
        recvTs: this.o.recvTs(),
        payload: res,
      });
      this.o.log("info", `resolved ${slug}: ${res.outcome} (${res.priceToBeat} → ${res.finalPrice})`);
    } catch (err) {
      this.o.log("warn", `${slug}: resolution poll failed: ${(err as Error).message}`);
    }
  }
}
