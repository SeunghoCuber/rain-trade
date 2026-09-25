// Network thread for live paper trading: owns every WebSocket (LiveFeeds) and only reads, normalizes
// and forwards events to the main thread in small batches. However long the engine takes on the main
// thread, sockets here are drained promptly, so the venue never drops us as a slow consumer.
import { parentPort, workerData } from "node:worker_threads";
import { makeRecvClock, type ClockAnchor, type Config, type MarketEvent } from "@rain/pm-harness-core";
import { LiveFeeds, type FeedHooks } from "@rain/pm-harness-feeds";

export interface FeedWorkerInput {
  cfg: Config;
  anchor: ClockAnchor;
}

export type FeedWorkerMessage =
  | { type: "events"; events: MarketEvent[] }
  | {
      type: "status";
      feeds: Record<string, { connected: boolean; lastEventMs: number | null; events: number }>;
      rtt: ReturnType<LiveFeeds["rtt"]>;
      markets: { marketId: string; slug: string; windowStart: number; windowEnd: number }[];
    };

const { cfg, anchor } = workerData as FeedWorkerInput;
const port = parentPort!;
const recvTs = makeRecvClock(anchor);
const log = (level: "info" | "warn" | "error", msg: string) =>
  (level === "info" ? console.log : console.error)(`${new Date().toISOString()} ${level.toUpperCase()} ${msg}`);

let batch: MarketEvent[] = [];
let scheduled = false;
const flush = () => {
  scheduled = false;
  if (!batch.length) return;
  port.postMessage({ type: "events", events: batch } satisfies FeedWorkerMessage);
  batch = [];
};

const feedState = new Map<string, { connected: boolean; lastEventMs: number | null; events: number }>();
const row = (n: string) => feedState.get(n) ?? feedState.set(n, { connected: false, lastEventMs: null, events: 0 }).get(n)!;
const hooks: FeedHooks = {
  emit: (ev) => {
    batch.push(ev);
    if (!scheduled) {
      scheduled = true;
      setImmediate(flush);
    }
  },
  recvTs,
  now: () => Date.now(),
  onState: (feed, connected, detail) => {
    row(feed).connected = connected;
    log(connected ? "info" : "warn", `${feed} ${connected ? "connected" : `disconnected (${detail})`}`);
  },
  onGap: (feed, gapMs, reason) => {
    if (gapMs > cfg.recorder.maxGapMs) log("warn", `${feed} gap ${gapMs}ms (${reason})`);
  },
  onEvents: (feed, n) => {
    const f = row(feed);
    f.events += n;
    f.lastEventMs = Date.now();
  },
  onParseError: (feed, err) => log("error", `${feed} parse error: ${err.message}`),
  onUnknownType: () => {},
  onMirrorMismatch: () => {},
};

const feeds = new LiveFeeds({ cfg, hooks, log, onMarketRetire: (m) => feedState.delete(`clob:${m.slug}`) });
feeds.start();
setInterval(() => {
  port.postMessage({
    type: "status",
    feeds: Object.fromEntries(feedState),
    rtt: feeds.rtt(),
    markets: feeds.activeMarkets.map((m) => ({ marketId: m.marketId, slug: m.slug, windowStart: m.windowStart, windowEnd: m.windowEnd })),
  } satisfies FeedWorkerMessage);
}, 2_000);
port.on("message", (m: { type: string }) => {
  if (m.type !== "stop") return;
  feeds.stop();
  flush();
  process.exit(0);
});
