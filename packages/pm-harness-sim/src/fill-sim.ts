import { toKey, type Clock, type Config, type FillMode, type MarketEvent, type MarketStates, type OrderStatus, type Side } from "@rain/pm-harness-core";

// Fill simulator (PLAN.md §4.5). Orders live in UP terms: BUY = bid for UP at p, SELL = ask for UP
// at p. The venue's book is unified (VERIFIED.md §3), so an UP ask at p is the same queue as a DOWN
// bid at 1−p, and DOWN prints hit it too (complementaryMatching).
//
// Rules:
//  1. An order goes live at t + ackLatency; queueAhead = displayed size at its level then × (1 + pad).
//  2. A cancel takes effect at t + cancelLatency; prints in between still fill it (adverse selection).
//  3. A print at our price: queueAhead −= size; any excess fills us.
//  4. A print through our price (sell below our bid / buy above our ask): fills us fully.
//  5. Post-only: if the order would cross when it goes live, it is rejected.
//  6. DOWN prints count against UP queues at 1−p when complementaryMatching is on.
//  7. Our size never changes the book (checked in the sanity suite).
// Queue decreases that are not explained by prints are cancels; which share of them was ahead of us
// is the mode's `cancelsAheadFrac` ("prorata" | fraction). Level increases join behind us.

export type ModeParams = Config["sim"]["modes"]["base"];

export interface SimOrderState {
  orderId: string;
  marketId: string;
  side: Side;
  price: number;
  size: number;
  remaining: number;
  status: OrderStatus;
  placedNs: bigint;
  liveNs: bigint | null;
  cancelReqNs: bigint | null;
  doneNs: bigint | null;
  queueAheadAtLive: number | null;
  queueAhead: number;
  /** displayed level size we last knew, net of prints we have applied since */
  levelSize: number;
  tag: string;
}

export interface FillInfo {
  order: SimOrderState;
  size: number;
  price: number;
  ns: bigint;
  duringCancelLatency: boolean;
  /** true if the print went through our price rather than eating the queue at it */
  through: boolean;
}

export interface FillSimStats {
  placed: number;
  rejected: number;
  cancelled: number;
  filledOrders: number;
  fills: number;
  filledSize: number;
  cancelLatencyFills: number;
}

export class FillSim {
  readonly mode: FillMode;
  private readonly p: ModeParams;
  private readonly clock: Clock;
  private readonly states: MarketStates;
  private readonly complementary: boolean;
  private readonly onFill: (f: FillInfo) => void;
  private readonly onDone: ((o: SimOrderState) => void) | undefined;
  /** open (not done) orders by market */
  private readonly open = new Map<string, Map<string, SimOrderState>>();
  private seq = 0;
  readonly stats: FillSimStats = { placed: 0, rejected: 0, cancelled: 0, filledOrders: 0, fills: 0, filledSize: 0, cancelLatencyFills: 0 };

  constructor(opts: {
    mode: FillMode;
    params: ModeParams;
    clock: Clock;
    states: MarketStates;
    complementaryMatching: boolean;
    onFill: (f: FillInfo) => void;
    onDone?: (o: SimOrderState) => void;
  }) {
    this.mode = opts.mode;
    this.p = opts.params;
    this.clock = opts.clock;
    this.states = opts.states;
    this.complementary = opts.complementaryMatching;
    this.onFill = opts.onFill;
    this.onDone = opts.onDone;
  }

  private ns(ms: number): bigint {
    return BigInt(Math.round(ms * 1e6));
  }

  openOrders(marketId: string): SimOrderState[] {
    return [...(this.open.get(marketId)?.values() ?? [])];
  }

  place(marketId: string, side: Side, price: number, size: number, tag = ""): SimOrderState {
    const now = this.clock.now();
    const o: SimOrderState = {
      orderId: `${this.mode[0]}${++this.seq}`,
      marketId,
      side,
      price,
      size,
      remaining: size,
      status: "PendingNew",
      placedNs: now,
      liveNs: null,
      cancelReqNs: null,
      doneNs: null,
      queueAheadAtLive: null,
      queueAhead: 0,
      levelSize: 0,
      tag,
    };
    let m = this.open.get(marketId);
    if (!m) this.open.set(marketId, (m = new Map()));
    m.set(o.orderId, o);
    this.stats.placed++;
    this.clock.schedule(now + this.ns(this.p.ackLatencyMs), () => this.goLive(o));
    return o;
  }

  cancel(o: SimOrderState): void {
    if (o.cancelReqNs !== null || this.isDone(o)) return;
    const now = this.clock.now();
    o.cancelReqNs = now;
    if (o.status === "Live" || o.status === "PartiallyFilled") o.status = "PendingCancel";
    this.clock.schedule(now + this.ns(this.p.cancelLatencyMs), () => {
      if (this.isDone(o)) return;
      if (o.status === "PendingNew") return; // goLive sees cancelReqNs and handles it
      this.finish(o, "Cancelled");
      this.stats.cancelled++;
    });
  }

  cancelAll(marketId: string): void {
    for (const o of this.openOrders(marketId)) this.cancel(o);
  }

  private isDone(o: SimOrderState): boolean {
    return o.status === "Filled" || o.status === "Cancelled" || o.status === "Rejected";
  }

  private finish(o: SimOrderState, status: "Filled" | "Cancelled" | "Rejected"): void {
    o.status = status;
    o.doneNs = this.clock.now();
    this.open.get(o.marketId)?.delete(o.orderId);
    this.onDone?.(o);
  }

  private goLive(o: SimOrderState): void {
    if (this.isDone(o)) return;
    const s = this.states.get(o.marketId);
    if (s.closed) {
      this.finish(o, "Cancelled");
      this.stats.cancelled++;
      return;
    }
    const q = s.book.quote("UP");
    const crosses = o.side === "BUY" ? q.ask !== null && o.price >= q.ask - 1e-9 : q.bid !== null && o.price <= q.bid + 1e-9;
    if (crosses) {
      this.finish(o, "Rejected");
      this.stats.rejected++;
      return;
    }
    const shown = s.book.sizeAt("UP", o.side, o.price);
    o.levelSize = shown;
    o.queueAhead = shown * (1 + this.p.queuePadFrac);
    o.queueAheadAtLive = o.queueAhead;
    o.liveNs = this.clock.now();
    // a cancel requested while in flight is still in flight: it lands at cancelReqNs + cancelLatency
    o.status = o.cancelReqNs !== null ? "PendingCancel" : "Live";
    if (o.cancelReqNs !== null && this.clock.now() >= o.cancelReqNs + this.ns(this.p.cancelLatencyMs)) {
      this.finish(o, "Cancelled");
      this.stats.cancelled++;
    }
  }

  /** Feed every market event before MarketStates.apply(ev) (level sizes are compared with what we knew). */
  onEvent(ev: MarketEvent): void {
    if (!ev.marketId) return;
    const orders = this.open.get(ev.marketId);
    if (!orders?.size) return;
    switch (ev.kind) {
      case "trade": {
        if (ev.token === "DOWN" && !this.complementary) return;
        // in UP terms: DOWN taker BUY at q == UP taker SELL at 1−q
        const up = ev.token !== "DOWN";
        const takerSide: Side = up ? ev.payload.side : ev.payload.side === "BUY" ? "SELL" : "BUY";
        const price = up ? ev.payload.price : 1 - ev.payload.price;
        this.onPrint(orders, takerSide, price, ev.payload.size);
        return;
      }
      case "book_delta":
        for (const c of ev.payload.changes) {
          const side: Side = c.token === "UP" ? c.side : c.side === "BUY" ? "SELL" : "BUY";
          const price = c.token === "UP" ? c.price : 1 - c.price;
          this.onLevel(orders, side, price, c.size);
        }
        return;
      case "book_snapshot": {
        const tok = ev.token ?? "UP";
        const sizes = new Map<string, number>();
        for (const [side, lv] of [["BUY", ev.payload.bids], ["SELL", ev.payload.asks]] as const) {
          for (const l of lv) {
            const upSide: Side = tok === "UP" ? side : side === "BUY" ? "SELL" : "BUY";
            const upPrice = tok === "UP" ? l.price : 1 - l.price;
            sizes.set(`${upSide}:${toKey(upPrice)}`, l.size);
          }
        }
        for (const o of [...orders.values()]) {
          if (o.liveNs === null) continue;
          this.onLevel(new Map([[o.orderId, o]]), o.side, o.price, sizes.get(`${o.side}:${toKey(o.price)}`) ?? 0);
        }
        return;
      }
      case "market_close":
        for (const o of [...orders.values()]) {
          this.finish(o, "Cancelled");
          this.stats.cancelled++;
        }
        return;
    }
  }

  private isFillable(o: SimOrderState): boolean {
    return o.status === "Live" || o.status === "PartiallyFilled" || o.status === "PendingCancel";
  }

  private onPrint(orders: Map<string, SimOrderState>, takerSide: Side, price: number, size: number): void {
    const now = this.clock.now();
    const pk = toKey(price);
    for (const o of [...orders.values()]) {
      if (!this.isFillable(o)) continue;
      // a taker SELL hits bids, a taker BUY lifts asks
      if ((o.side === "BUY") !== (takerSide === "SELL")) continue;
      const ok = toKey(o.price);
      const through = o.side === "BUY" ? pk < ok : pk > ok;
      if (!through && pk !== ok) continue;
      let fill = 0;
      if (through) fill = o.remaining;
      else {
        o.queueAhead -= size;
        o.levelSize = Math.max(0, o.levelSize - size);
        if (o.queueAhead < 0) {
          fill = Math.min(-o.queueAhead, o.remaining);
          o.queueAhead = 0;
        }
      }
      if (fill <= 0) continue;
      o.remaining -= fill;
      const duringCancelLatency = o.status === "PendingCancel";
      this.stats.fills++;
      this.stats.filledSize += fill;
      if (duringCancelLatency) this.stats.cancelLatencyFills++;
      if (o.remaining <= 1e-9) {
        o.remaining = 0;
        this.stats.filledOrders++;
        this.onFill({ order: o, size: fill, price: o.price, ns: now, duringCancelLatency, through });
        this.finish(o, "Filled");
      } else {
        if (o.status === "Live") o.status = "PartiallyFilled";
        this.onFill({ order: o, size: fill, price: o.price, ns: now, duringCancelLatency, through });
      }
    }
  }

  private onLevel(orders: Map<string, SimOrderState>, side: Side, price: number, newSize: number): void {
    const pk = toKey(price);
    for (const o of orders.values()) {
      if (o.liveNs === null || this.isDone(o) || o.side !== side || toKey(o.price) !== pk) continue;
      const delta = o.levelSize - newSize;
      if (delta > 0) {
        // cancels (prints were already taken off levelSize): how many were ahead of us?
        const f = this.p.cancelsAheadFrac;
        const ahead = f === "prorata" ? (o.levelSize > 0 ? (delta * Math.min(o.queueAhead, o.levelSize)) / o.levelSize : 0) : f * delta;
        o.queueAhead = Math.max(0, o.queueAhead - ahead);
      }
      // whatever is ahead of us can never exceed what is displayed (plus the mode's pessimism pad)
      o.queueAhead = Math.min(o.queueAhead, newSize * (1 + this.p.queuePadFrac));
      o.levelSize = newSize;
    }
  }
}
