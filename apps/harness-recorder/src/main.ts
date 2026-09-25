import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { encodeEvent, loadConfig, makeRecvClock, type MarketEvent } from "@rain/pm-harness-core";
import {
  clobFeedName,
  createBinanceFeed,
  createClobFeed,
  createCoinbaseFeed,
  createRtdsFeed,
  defaultFetchJson,
  Discovery,
  type FeedHooks,
  type ResilientWs,
} from "@rain/pm-harness-feeds";
import { Health, makeAlert } from "./health.ts";
import { HourlyNdjsonWriter } from "./writer.ts";

const cfg = loadConfig(process.argv[2] ?? "config/default.yaml");
const rc = cfg.recorder;
const now = () => Date.now();
const recvTs = makeRecvClock();

const log = (level: "info" | "warn" | "error", msg: string) =>
  (level === "info" ? console.log : console.error)(`${new Date().toISOString()} ${level.toUpperCase()} ${msg}`);

mkdirSync(rc.dataDir, { recursive: true });
const writer = new HourlyNdjsonWriter(rc.dataDir, now, (e) => log("error", `writer: ${e.message}`));
writer.recoverLeftovers();

const counts: Partial<Record<MarketEvent["kind"], number>> = {};
const emit = (ev: MarketEvent) => {
  counts[ev.kind] = (counts[ev.kind] ?? 0) + 1;
  writer.write(encodeEvent(ev));
};

const alert = makeAlert(rc.alertWebhookUrl, (m) => log("warn", m));
const health = new Health(now, alert, (feed) =>
  feed.startsWith("clob:") ? rc.silenceMs.clob : feed.startsWith("rtds:") ? rc.silenceMs.rtds : rc.silenceMs[feed === "spot:binance" ? "binance" : "coinbase"],
);

const unknownLogged = new Set<string>();
const hooks: FeedHooks = {
  emit,
  recvTs,
  now,
  onState: (feed, connected, detail) => {
    health.onState(feed, connected, detail);
    log(connected ? "info" : "warn", `${feed} ${connected ? "connected" : `disconnected (${detail})`}`);
  },
  onGap: (feed, gapMs, reason) => {
    health.onGap(feed, gapMs, reason);
    log(gapMs > rc.maxGapMs ? "warn" : "info", `${feed} gap ${gapMs}ms (${reason})`);
  },
  onEvents: (feed, n) => health.onEvents(feed, n),
  onParseError: (feed, err, raw) => {
    health.feed(feed).parseErrors++;
    log("error", `${feed} parse error: ${err.message}; raw=${raw.slice(0, 300)}`);
  },
  onUnknownType: (feed, type) => {
    const f = health.feed(feed);
    f.unknownTypes[type] = (f.unknownTypes[type] ?? 0) + 1;
    if (!unknownLogged.has(type)) {
      unknownLogged.add(type);
      log("warn", `${feed} unhandled event_type "${type}" (stored as venue_raw)`);
    }
  },
  onMirrorMismatch: (feed, n) => {
    health.feed(feed).mirrorMismatches += n;
  },
};

const globalFeeds: ResilientWs[] = [createRtdsFeed(cfg, hooks)];
if (rc.spotSources.includes("binance")) globalFeeds.push(createBinanceFeed(cfg, hooks));
if (rc.spotSources.includes("coinbase")) globalFeeds.push(createCoinbaseFeed(cfg, hooks));

const clobFeeds = new Map<string, ResilientWs>();
const discovery = new Discovery({
  gammaUrl: cfg.venue.gammaUrl,
  slugPrefix: cfg.market.slugPrefix,
  durationSec: cfg.market.durationSec,
  discoveryPollSec: rc.discoveryPollSec,
  preRegisterSec: rc.preRegisterSec,
  postCloseGraceSec: rc.postCloseGraceSec,
  resolutionGiveUpSec: rc.resolutionGiveUpSec,
  fetchJson: defaultFetchJson,
  emit,
  recvTs,
  now,
  log,
  onOpen: (m) => {
    const feed = createClobFeed(cfg, m, hooks);
    clobFeeds.set(m.marketId, feed);
    health.feed(clobFeedName(m));
    feed.start();
  },
  onRetire: (m) => {
    clobFeeds.get(m.marketId)?.stop();
    clobFeeds.delete(m.marketId);
    health.remove(clobFeedName(m));
    log("info", `retired ${m.slug}`);
  },
});

for (const f of globalFeeds) f.start();
discovery.seedRecentResolutions();

let refreshing = false;
const refresh = async () => {
  if (refreshing) return;
  refreshing = true;
  try {
    await discovery.refresh();
  } finally {
    refreshing = false;
  }
};
void refresh();

const statusPath = join(rc.dataDir, "status.json");
const timers = [
  setInterval(() => void refresh(), rc.discoveryPollSec * 1000),
  setInterval(() => discovery.tick(), 250),
  setInterval(() => {
    health.check();
    health.writeStatus(statusPath, {
      pid: process.pid,
      file: writer.currentPath,
      linesWritten: writer.lines,
      bytesWritten: writer.bytes,
      eventCounts: counts,
      activeMarkets: discovery.activeMarkets.map((m) => m.slug),
      pendingResolutions: discovery.pendingResolutions,
    });
  }, rc.statusIntervalSec * 1000),
];

log("info", `recorder started: data=${rc.dataDir} spot=${rc.spotSources.join(",")} dropMirrored=${rc.dropMirrored}`);

let stopping = false;
async function shutdown(signal: string, code = 0) {
  if (stopping) return;
  stopping = true;
  log("info", `${signal}: shutting down`);
  for (const t of timers) clearInterval(t);
  for (const f of [...globalFeeds, ...clobFeeds.values()]) f.stop();
  await writer.close();
  log("info", `flushed ${writer.lines} lines; bye`);
  process.exit(code);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("uncaughtException", (e) => {
  log("error", `uncaught: ${e.stack ?? e.message}`);
  alert(`recorder crashed: ${e.message}`);
  void shutdown("uncaughtException", 1);
});
