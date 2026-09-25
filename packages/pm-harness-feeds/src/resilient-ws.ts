export type GapReason = "reconnect" | "silence";

export interface ResilientWsOptions {
  name: string;
  url: string;
  /** called on every (re)connect; send subscriptions here */
  onOpen: (send: (data: string) => void) => void;
  /** every text frame, including PONGs */
  onMessage: (data: string) => void;
  /**
   * Fired once when data resumes after an outage. gapMs = time between the last frame before the
   * outage and the first frame after it.
   */
  onGap: (gapMs: number, reason: GapReason) => void;
  onStateChange?: (connected: boolean, detail: string) => void;
  /** application-level keepalive (Polymarket expects text "PING") */
  ping?: { payload: string; intervalMs: number };
  /** force a reconnect after this long without any frame */
  silenceMs: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  now?: () => number;
}

export interface WsStats {
  connected: boolean;
  frames: number;
  reconnects: number;
  lastFrameMs: number | null;
}

/** WebSocket with reconnect + exponential backoff, keepalive, and a silence watchdog. */
export class ResilientWs {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoffMs: number;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** set when an outage starts; cleared (and reported) on the next frame */
  private outage: GapReason | null = null;
  /** when the current connection opened; a fresh connection gets a full silenceMs before it can be judged silent */
  private openedMs = 0;
  private readonly now: () => number;
  readonly stats: WsStats = { connected: false, frames: 0, reconnects: 0, lastFrameMs: null };

  private readonly o: ResilientWsOptions;

  constructor(o: ResilientWsOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.backoffMs = o.backoffMinMs ?? 500;
  }

  start(): void {
    this.stopped = false;
    this.connect();
    this.watchdog = setInterval(() => this.checkSilence(), Math.min(1000, this.o.silenceMs / 2));
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.teardown();
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.o.url);
    this.ws = ws;
    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.stats.connected = true;
      this.openedMs = this.now();
      this.backoffMs = this.o.backoffMinMs ?? 500;
      this.o.onStateChange?.(true, "open");
      this.o.onOpen((d) => ws.readyState === WebSocket.OPEN && ws.send(d));
      if (this.o.ping) {
        const { payload, intervalMs } = this.o.ping;
        this.pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(payload), intervalMs);
      }
    };
    ws.onmessage = (e: MessageEvent) => {
      if (ws !== this.ws) return;
      const t = this.now();
      if (this.outage && this.stats.lastFrameMs !== null) {
        this.o.onGap(t - this.stats.lastFrameMs, this.outage);
      }
      this.outage = null;
      this.stats.frames++;
      this.stats.lastFrameMs = t;
      if (typeof e.data === "string") this.o.onMessage(e.data);
    };
    ws.onclose = (e: CloseEvent) => {
      if (ws !== this.ws) return;
      this.handleDrop(`close ${e.code}${e.reason ? ` ${e.reason}` : ""}`, "reconnect");
    };
    ws.onerror = () => {
      if (ws !== this.ws) return;
      this.handleDrop("error", "reconnect");
    };
  }

  private checkSilence(): void {
    if (this.stopped || !this.stats.connected) return;
    // measure from the later of the last frame and this connection's open, otherwise after a long
    // outage (e.g. machine sleep) every new connection is dropped before its first frame arrives
    const since = Math.max(this.stats.lastFrameMs ?? 0, this.openedMs);
    if (this.now() - since > this.o.silenceMs) {
      this.handleDrop(`silent ${this.now() - since}ms`, "silence");
    }
  }

  private handleDrop(detail: string, reason: GapReason): void {
    this.teardown();
    if (this.stopped) return;
    // a silence-triggered drop keeps its reason even though it also reconnects
    this.outage ??= reason;
    this.o.onStateChange?.(false, detail);
    this.stats.reconnects++;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.o.backoffMaxMs ?? 30_000);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private teardown(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    const ws = this.ws;
    this.ws = null;
    this.stats.connected = false;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
  }
}
