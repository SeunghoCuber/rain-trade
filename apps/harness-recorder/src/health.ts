import { renameSync, writeFileSync } from "node:fs";

export interface FeedState {
  connected: boolean;
  lastEventMs: number | null;
  events: number;
  reconnects: number;
  gaps: number;
  maxGapMs: number;
  sequenceBreaks: number;
  parseErrors: number;
  mirrorMismatches: number;
  unknownTypes: Record<string, number>;
  lastDetail: string;
  /** currently alerting as down */
  down: boolean;
  /** when this feed was registered: its silence clock starts here, not at process start */
  createdMs: number;
}

const newFeed = (createdMs: number): FeedState => ({
  connected: false,
  lastEventMs: null,
  events: 0,
  reconnects: 0,
  gaps: 0,
  maxGapMs: 0,
  sequenceBreaks: 0,
  parseErrors: 0,
  mirrorMismatches: 0,
  unknownTypes: {},
  lastDetail: "",
  down: false,
  createdMs,
});

export type Alert = (text: string) => void;

/** Per-feed counters, a status.json snapshot, and down/recovered alerts. */
export class Health {
  readonly feeds = new Map<string, FeedState>();
  readonly startedMs: number;

  private readonly now: () => number;
  private readonly alert: Alert;
  /** a feed with no events for this long (while it should be live) is reported down */
  private readonly downAfterMs: (feed: string) => number;

  constructor(now: () => number, alert: Alert, downAfterMs: (feed: string) => number) {
    this.now = now;
    this.alert = alert;
    this.downAfterMs = downAfterMs;
    this.startedMs = now();
  }

  feed(name: string): FeedState {
    let f = this.feeds.get(name);
    if (!f) this.feeds.set(name, (f = newFeed(this.now())));
    return f;
  }

  remove(name: string): void {
    this.feeds.delete(name);
  }

  onState(name: string, connected: boolean, detail: string): void {
    const f = this.feed(name);
    if (!connected && f.connected) f.reconnects++;
    f.connected = connected;
    f.lastDetail = detail;
  }

  onEvents(name: string, n: number): void {
    const f = this.feed(name);
    f.events += n;
    f.lastEventMs = this.now();
    if (f.down) {
      f.down = false;
      this.alert(`✅ ${name} recovered`);
    }
  }

  onGap(name: string, gapMs: number, reason: string): void {
    const f = this.feed(name);
    if (reason === "sequence_break") f.sequenceBreaks++;
    else f.gaps++;
    f.maxGapMs = Math.max(f.maxGapMs, gapMs);
  }

  /** Called periodically: raise alerts for feeds that went quiet. */
  check(): void {
    const now = this.now();
    for (const [name, f] of this.feeds) {
      const since = now - (f.lastEventMs ?? f.createdMs);
      if (!f.down && since > this.downAfterMs(name)) {
        f.down = true;
        this.alert(`🚨 ${name} silent for ${Math.round(since / 1000)}s (${f.connected ? "connected" : f.lastDetail || "disconnected"})`);
      }
    }
  }

  writeStatus(path: string, extra: Record<string, unknown>): void {
    const status = {
      updatedAt: new Date(this.now()).toISOString(),
      uptimeSec: Math.round((this.now() - this.startedMs) / 1000),
      ...extra,
      feeds: Object.fromEntries(this.feeds),
    };
    writeFileSync(`${path}.tmp`, JSON.stringify(status, null, 2));
    renameSync(`${path}.tmp`, path);
  }
}

export function makeAlert(webhookUrl: string | null, log: (msg: string) => void): Alert {
  return (text) => {
    log(`ALERT ${text}`);
    if (!webhookUrl) return;
    fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `[raintrade-recorder] ${text}` }),
      signal: AbortSignal.timeout(10_000),
    }).catch((e: Error) => log(`alert webhook failed: ${e.message}`));
  };
}
