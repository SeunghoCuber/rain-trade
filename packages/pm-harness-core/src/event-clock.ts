import type { MarketEvent } from "./events.ts";

// The engine never talks to a feed. It consumes one ordered stream of MarketEvents through a Clock
// (PLAN.md §2), fed either by a replay of recorded data or by the live feeds. Time is the local
// receive time (recvTs, ns): what we would actually have known at that moment.

export type TimerId = number;

export interface Clock {
  /** current time, ns (recvTs scale) */
  now(): bigint;
  /** run `fn` once time reaches `atNs` (immediately-due timers still run asynchronously, in order) */
  schedule(atNs: bigint, fn: () => void): TimerId;
  cancel(id: TimerId): void;
}

export const nsFromMs = (ms: number): bigint => BigInt(Math.round(ms * 1e6));
export const msFromNs = (ns: bigint): number => Number(ns) / 1e6;

interface Timer {
  at: bigint;
  seq: number;
  fn: () => void;
}

/**
 * Replay clock: time only moves when an event (or a due timer) says so. Timers due at or before an
 * event's time fire before that event, in (time, schedule order). Fully deterministic.
 */
export class ReplayClock implements Clock {
  private t = 0n;
  private seq = 0;
  private readonly heap: Timer[] = [];
  /** scheduled and not yet fired or cancelled */
  private readonly live = new Set<number>();
  timersFired = 0;

  now(): bigint {
    return this.t;
  }

  schedule(atNs: bigint, fn: () => void): TimerId {
    const id = ++this.seq;
    this.live.add(id);
    push(this.heap, { at: atNs < this.t ? this.t : atNs, seq: id, fn });
    return id;
  }

  cancel(id: TimerId): void {
    this.live.delete(id);
  }

  /** Fire every timer due at or before `ns`, then set now = ns. Time never goes backwards. */
  advanceTo(ns: bigint): void {
    // an out-of-order (earlier) event is handled at the current time, after timers due by then
    if (ns < this.t) ns = this.t;
    for (;;) {
      const top = this.heap[0];
      if (!top || top.at > ns) break;
      pop(this.heap);
      if (!this.live.delete(top.seq)) continue; // cancelled
      if (top.at > this.t) this.t = top.at;
      this.timersFired++;
      top.fn();
    }
    if (ns > this.t) this.t = ns;
  }

  get pendingTimers(): number {
    return this.live.size;
  }
}

/** Live clock: wall-anchored monotonic time (same scale as the recorder's recvTs); timers via setTimeout. */
export class LiveClock implements Clock {
  private seq = 0;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly nowFn: () => bigint;

  constructor(nowFn: () => bigint) {
    this.nowFn = nowFn;
  }

  now(): bigint {
    return this.nowFn();
  }

  schedule(atNs: bigint, fn: () => void): TimerId {
    const id = ++this.seq;
    const delayMs = Math.max(0, msFromNs(atNs - this.nowFn()));
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        fn();
      }, delayMs),
    );
    return id;
  }

  cancel(id: TimerId): void {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
  }
}

export interface RunStats {
  events: number;
  firstNs: bigint | null;
  lastNs: bigint | null;
  /** events whose recvTs was earlier than the clock (source not in time order); processed at clock time */
  outOfOrder: number;
}

/**
 * Drive `handler` with every event from `source`, advancing a ReplayClock so timers interleave
 * correctly. The same handler can run live by iterating a live source with a LiveClock instead.
 */
export async function runReplay(
  source: AsyncIterable<MarketEvent> | Iterable<MarketEvent>,
  clock: ReplayClock,
  handler: (ev: MarketEvent, clock: Clock) => void,
): Promise<RunStats> {
  const stats: RunStats = { events: 0, firstNs: null, lastNs: null, outOfOrder: 0 };
  for await (const ev of source) {
    if (ev.recvTs < clock.now()) stats.outOfOrder++;
    clock.advanceTo(ev.recvTs);
    stats.events++;
    stats.firstNs ??= ev.recvTs;
    stats.lastNs = ev.recvTs;
    handler(ev, clock);
  }
  return stats;
}

/** Unbounded async queue: the live feeds push, the engine iterates. Same interface as a replay source. */
export class AsyncEventQueue<T = MarketEvent> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private head = 0;
  private waiter: ((r: IteratorResult<T>) => void) | null = null;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: item, done: false });
    } else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined as never, done: true });
    }
  }

  get size(): number {
    return this.items.length - this.head;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.head < this.items.length) {
          const value = this.items[this.head++]!;
          if (this.head > 4096 && this.head * 2 > this.items.length) {
            this.items.splice(0, this.head);
            this.head = 0;
          }
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => (this.waiter = resolve));
      },
    };
  }
}

// binary min-heap on (at, seq)
const less = (a: Timer, b: Timer) => a.at < b.at || (a.at === b.at && a.seq < b.seq);

function push(h: Timer[], x: Timer): void {
  h.push(x);
  let i = h.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (!less(h[i]!, h[p]!)) break;
    [h[i], h[p]] = [h[p]!, h[i]!];
    i = p;
  }
}

function pop(h: Timer[]): Timer | undefined {
  const top = h[0];
  const last = h.pop();
  if (h.length && last) {
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < h.length && less(h[l]!, h[m]!)) m = l;
      if (r < h.length && less(h[r]!, h[m]!)) m = r;
      if (m === i) break;
      [h[i], h[m]] = [h[m]!, h[i]!];
      i = m;
    }
  }
  return top;
}
