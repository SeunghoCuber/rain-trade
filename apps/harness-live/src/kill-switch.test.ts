import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@rain/pm-harness-core";
import { describe, expect, it } from "vitest";
import { GatedStrategy, KillSwitch } from "./kill-switch.ts";

const base = loadConfig(new URL("../../../config/default.yaml", import.meta.url).pathname);
const cfg = { ...base, live: { ...base.live, killSwitch: { maxDrawdownUsd: 100, minRolling7dEdgeCents: -0.5, minMarkets: 3 } } };
const file = () => join(mkdtempSync(join(tmpdir(), "raintrade-kill-")), "KILL");
const DAY = 86_400_000;

describe("KillSwitch", () => {
  it("trips on drawdown from the running peak", () => {
    const k = new KillSwitch(cfg, file());
    k.add({ windowStart: 0, pnl: 50, volume: 100 });
    k.add({ windowStart: 1, pnl: -90, volume: 100 });
    expect(k.halted).toBeNull();
    k.add({ windowStart: 2, pnl: -20, volume: 100 });
    expect(k.halted).toMatch(/drawdown \$110/);
  });

  it("trips on a rolling 7-day edge below the floor, only once enough markets are in", () => {
    const k = new KillSwitch(cfg, file());
    k.add({ windowStart: 10 * DAY, pnl: -1, volume: 100 }); // −1¢/share, but 1 market
    k.add({ windowStart: 10 * DAY + 1, pnl: -1, volume: 100 });
    expect(k.halted).toBeNull();
    k.add({ windowStart: 10 * DAY + 2, pnl: -1, volume: 100 });
    expect(k.halted).toMatch(/rolling 7-day edge -1\.000/);
  });

  it("computes the rolling edge over the last 7 days only", () => {
    const old = [0, 1, 2].map((i) => ({ windowStart: i, pnl: -30, volume: 1000 })); // −3¢/share, but long ago
    const k = new KillSwitch({ ...cfg, live: { ...cfg.live, killSwitch: { ...cfg.live.killSwitch, maxDrawdownUsd: 1e9 } } }, file(), old);
    expect(k.halted).not.toBeNull(); // they were recent when they were added
    const fresh = new KillSwitch({ ...cfg, live: { ...cfg.live, killSwitch: { ...cfg.live.killSwitch, maxDrawdownUsd: 1e9 } } }, file());
    for (const h of old) fresh.add(h);
    expect(fresh.stats(30 * DAY).rolling7d.markets).toBe(0);
  });

  it("honours a manual KILL file and gates the strategy", () => {
    const f = file();
    const k = new KillSwitch(cfg, f);
    const inner = { name: "x", quote: () => ({ bid: 0.4, ask: 0.6, size: 5 }) };
    const g = new GatedStrategy(inner, k);
    expect(g.quote({} as never)).not.toBeNull();
    writeFileSync(f, "");
    k.evaluate(0);
    expect(k.halted).toMatch(/manual kill file/);
    expect(g.quote({} as never)).toBeNull();
  });
});
