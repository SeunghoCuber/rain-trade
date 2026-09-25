import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { encodeEvent, loadConfig, makeRecvClock, type MarketEvent } from "@rain/pm-harness-core";
import { clobFeedName, LiveFeeds, type FeedHooks } from "@rain/pm-harness-feeds";
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

const feeds = new LiveFeeds({
  cfg,
  hooks,
  log,
  onMarketOpen: (m) => health.feed(clobFeedName(m)),
  onMarketRetire: (m) => health.remove(clobFeedName(m)),
});

// Keep the Mac awake from inside the process (not by wrapping it in caffeinate): launchd must start
// node itself, or macOS privacy checks for ~/Documents apply to caffeinate and the job cannot start.
if (rc.preventSleep && process.platform === "darwin") {
  const c = spawn("/usr/bin/caffeinate", ["-i", "-s", "-w", String(process.pid)], { stdio: "ignore" });
  c.on("error", (e) => log("warn", `caffeinate unavailable: ${e.message}`));
  c.unref();
  log("info", `sleep prevention on (caffeinate pid ${c.pid})`);
}

feeds.start();

const statusPath = join(rc.dataDir, "status.json");
const timers = [
  setInterval(() => {
    health.check();
    health.writeStatus(statusPath, {
      pid: process.pid,
      file: writer.currentPath,
      linesWritten: writer.lines,
      bytesWritten: writer.bytes,
      eventCounts: counts,
      activeMarkets: feeds.activeMarkets.map((m) => m.slug),
      pendingResolutions: feeds.pendingResolutions,
      rttMs: feeds.rtt(),
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
  feeds.stop();
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
