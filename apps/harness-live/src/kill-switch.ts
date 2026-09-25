import { existsSync } from "node:fs";
import type { Config } from "@rain/pm-harness-core";
import type { DesiredQuotes, QuoteContext, Strategy } from "@rain/pm-harness-strategy";

export interface SettledMarket {
  windowStart: number;
  pnl: number;
  volume: number;
}

/**
 * Stops quoting (all modes) when the pessimistic track record says so (PLAN.md §12 kill switch):
 * a drawdown from peak beyond maxDrawdownUsd, a rolling 7-day edge below the floor once enough
 * markets are in, or a manual KILL file. Once tripped it stays tripped until restart.
 */
export class KillSwitch {
  private readonly k: Config["live"]["killSwitch"];
  private readonly killFile: string;
  private readonly history: SettledMarket[] = [];
  halted: string | null = null;

  constructor(cfg: Config, killFile: string, history: SettledMarket[] = []) {
    this.k = cfg.live.killSwitch;
    this.killFile = killFile;
    for (const h of history) this.add(h);
  }

  add(m: SettledMarket): void {
    this.history.push(m);
    this.evaluate(m.windowStart);
  }

  stats(nowMs: number) {
    let cum = 0, peak = 0, dd = 0;
    for (const h of this.history) {
      cum += h.pnl;
      peak = Math.max(peak, cum);
      dd = Math.min(dd, cum - peak);
    }
    const week = this.history.filter((h) => h.windowStart >= nowMs - 7 * 86_400_000);
    const vol = week.reduce((a, h) => a + h.volume, 0);
    return {
      markets: this.history.length,
      cumulativePnl: cum,
      drawdown: dd,
      rolling7d: { markets: week.length, edgeCents: vol ? (100 * week.reduce((a, h) => a + h.pnl, 0)) / vol : null },
    };
  }

  evaluate(nowMs: number): void {
    if (this.halted) return;
    if (existsSync(this.killFile)) {
      this.halted = `manual kill file ${this.killFile}`;
      return;
    }
    const s = this.stats(nowMs);
    if (-s.drawdown > this.k.maxDrawdownUsd) this.halted = `drawdown $${(-s.drawdown).toFixed(2)} > $${this.k.maxDrawdownUsd}`;
    else if (s.rolling7d.markets >= this.k.minMarkets && s.rolling7d.edgeCents !== null && s.rolling7d.edgeCents < this.k.minRolling7dEdgeCents) {
      this.halted = `rolling 7-day edge ${s.rolling7d.edgeCents.toFixed(3)}¢/sh < ${this.k.minRolling7dEdgeCents}¢ over ${s.rolling7d.markets} markets`;
    }
  }
}

/** Passes quotes through until the kill switch trips, then pulls everything. */
export class GatedStrategy implements Strategy {
  readonly name: string;
  private readonly inner: Strategy;
  private readonly gate: KillSwitch;

  constructor(inner: Strategy, gate: KillSwitch) {
    this.inner = inner;
    this.gate = gate;
    this.name = inner.name;
  }

  quote(ctx: QuoteContext): DesiredQuotes | null {
    return this.gate.halted ? null : this.inner.quote(ctx);
  }
}
