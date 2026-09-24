import type { FillMode, Side, Token } from "./events.ts";

export type OrderStatus =
  | "PendingNew"
  | "Live"
  | "PartiallyFilled"
  | "PendingCancel"
  | "Filled"
  | "Cancelled"
  | "Rejected";

export interface SimOrder {
  orderId: string;
  runId: string;
  mode: FillMode;
  marketId: string;
  token: Token;
  side: Side;
  /** 0..1, tick-aligned */
  price: number;
  size: number;
  placedTs: number;
  liveTs?: number;
  cancelReqTs?: number;
  doneTs?: number;
  status: OrderStatus;
  queueAheadAtLive?: number;
}

export interface SimFill {
  fillId: string;
  orderId: string;
  runId: string;
  mode: FillMode;
  marketId: string;
  token: Token;
  side: Side;
  price: number;
  size: number;
  ts: number;
  secondsToClose: number;
  /** Up-probability at fill time */
  fvAtFill: number;
  sigmaAtFill: number;
  /** Up-equivalent shares */
  inventoryBefore: number;
  duringCancelLatency: boolean;
}

export interface MarketResult {
  runId: string;
  mode: FillMode;
  marketId: string;
  windowStart: number;
  /** 1 if Up won */
  outcome: 0 | 1;
  pnlTrading: number;
  pnlSpread: number;
  pnlAdverse: number;
  pnlInventory: number;
  rebateEst: number;
  fees: number;
  volumeFilled: number;
  maxAbsInventory: number;
  quoteUptimePct: number;
  realizedVol: number;
  /** feed gap, settlement mismatch */
  excluded: boolean;
}
