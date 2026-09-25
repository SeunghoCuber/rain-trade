import type { Config } from "@rain/pm-harness-core";
import { Discovery } from "./discovery.ts";
import { createBinanceFeed, createClobFeed, createCoinbaseFeed, createRtdsFeed, type FeedHooks } from "./feeds.ts";
import { defaultFetchJson, type FetchJson, type MarketInfo } from "./gamma.ts";
import type { ResilientWs } from "./resilient-ws.ts";

export interface LiveFeedsOptions {
  cfg: Config;
  hooks: FeedHooks;
  log: (level: "info" | "warn", msg: string) => void;
  onMarketOpen?: (m: MarketInfo) => void;
  onMarketRetire?: (m: MarketInfo) => void;
  fetchJson?: FetchJson;
}

/**
 * Everything that talks to the venues: market discovery, Chainlink + spot feeds, and one CLOB
 * connection per live market. The recorder writes its events to disk; the live paper trader feeds
 * them to the engine. Both get exactly the same stream.
 */
export class LiveFeeds {
  private readonly o: LiveFeedsOptions;
  private readonly globalFeeds: ResilientWs[] = [];
  private readonly clobFeeds = new Map<string, ResilientWs>();
  private readonly discovery: Discovery;
  private timers: ReturnType<typeof setInterval>[] = [];
  private refreshing = false;

  constructor(o: LiveFeedsOptions) {
    this.o = o;
    const { cfg, hooks } = o;
    const rc = cfg.recorder;
    this.globalFeeds.push(createRtdsFeed(cfg, hooks));
    if (rc.spotSources.includes("binance")) this.globalFeeds.push(createBinanceFeed(cfg, hooks));
    if (rc.spotSources.includes("coinbase")) this.globalFeeds.push(createCoinbaseFeed(cfg, hooks));
    this.discovery = new Discovery({
      gammaUrl: cfg.venue.gammaUrl,
      slugPrefix: cfg.market.slugPrefix,
      durationSec: cfg.market.durationSec,
      discoveryPollSec: rc.discoveryPollSec,
      preRegisterSec: rc.preRegisterSec,
      postCloseGraceSec: rc.postCloseGraceSec,
      resolutionGiveUpSec: rc.resolutionGiveUpSec,
      fetchJson: o.fetchJson ?? defaultFetchJson,
      emit: hooks.emit,
      recvTs: hooks.recvTs,
      now: hooks.now,
      log: o.log,
      onOpen: (m) => {
        const feed = createClobFeed(cfg, m, hooks);
        this.clobFeeds.set(m.marketId, feed);
        o.onMarketOpen?.(m);
        feed.start();
      },
      onRetire: (m) => {
        this.clobFeeds.get(m.marketId)?.stop();
        this.clobFeeds.delete(m.marketId);
        o.onMarketRetire?.(m);
        o.log("info", `retired ${m.slug}`);
      },
    });
  }

  start(): void {
    for (const f of this.globalFeeds) f.start();
    this.discovery.seedRecentResolutions();
    void this.refresh();
    this.timers = [setInterval(() => void this.refresh(), this.o.cfg.recorder.discoveryPollSec * 1000), setInterval(() => this.discovery.tick(), 250)];
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    for (const f of [...this.globalFeeds, ...this.clobFeeds.values()]) f.stop();
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await this.discovery.refresh();
    } finally {
      this.refreshing = false;
    }
  }

  get activeMarkets(): MarketInfo[] {
    return this.discovery.activeMarkets;
  }

  get pendingResolutions(): number {
    return this.discovery.pendingResolutions;
  }

  /** Application-level ping round trip per connection (ms), where the venue answers pings. */
  rtt(): Record<string, { lastMs: number | null; ewmaMs: number | null }> {
    const out: Record<string, { lastMs: number | null; ewmaMs: number | null }> = {};
    for (const f of [...this.globalFeeds, ...this.clobFeeds.values()]) out[f.name] = { lastMs: f.stats.rttMs, ewmaMs: f.stats.rttEwmaMs };
    return out;
  }
}
