import { createHash } from "node:crypto";
import { loadConfig, ReplayClock, runReplay, type FillMode, type MarketEvent } from "@rain/pm-harness-core";
import { describe, expect, it } from "vitest";
import { BacktestRunner, type RunnerOptions } from "./runner.ts";
import { MarketMaker, NoQuote, RandomQuote, type Strategy } from "./strategy.ts";
import { syntheticMarket } from "./synthetic.ts";

// PLAN.md §9 sanity checks on synthetic data (the CLI `pnpm sanity` runs them on recorded data).
const cfg = loadConfig(new URL("../../../config/default.yaml", import.meta.url).pathname);
const streams = [11, 12, 13].map((seed, i) => syntheticMarket(seed, `0xsyn${i}`));

async function run(strategy: (m: FillMode) => Strategy, extra: Partial<RunnerOptions> = {}): Promise<BacktestRunner> {
  const clock = new ReplayClock();
  const r = new BacktestRunner({ cfg, clock, strategy, ...extra });
  for (const s of streams) await runReplay(s as MarketEvent[], clock, (ev) => r.handle(ev));
  return r;
}
const digest = (r: BacktestRunner) =>
  createHash("sha256").update(JSON.stringify(r.results)).update(JSON.stringify(r.allFills())).digest("hex");
const sum = (r: BacktestRunner, mode: FillMode, f: (x: BacktestRunner["results"][number]) => number) =>
  r.results.filter((x) => x.mode === mode).reduce((a, x) => a + f(x), 0);

describe("sanity checks on synthetic markets", () => {
  it("1. decomposition identity holds for every market and mode", async () => {
    const r = await run(() => new MarketMaker(cfg));
    expect(r.results).toHaveLength(9);
    expect(sum(r, "base", (x) => x.fills)).toBeGreaterThan(10);
    for (const x of r.results) expect(x.decompError).toBeLessThan(1e-9);
  });

  it("2. a strategy that never quotes has exactly zero PnL", async () => {
    const r = await run(() => new NoQuote());
    expect(r.allFills()).toHaveLength(0);
    for (const x of r.results) expect([x.pnlTrading, x.rebateEst, x.volumeFilled]).toEqual([0, 0, 0]);
  });

  it("3. random quotes around a stale book do not earn spread + adverse selection", async () => {
    const r = await run((m) => new RandomQuote(cfg, `t-${m}`));
    const v = sum(r, "base", (x) => x.volumeFilled);
    expect(v).toBeGreaterThan(0);
    expect(sum(r, "base", (x) => x.pnlSpread + x.pnlAdverse) / v).toBeLessThanOrEqual(0.002);
  });

  it("4. knowing FV 5 s ahead earns clearly positive adverse-selection PnL", async () => {
    const mm = await run(() => new MarketMaker(cfg));
    const fs = await run(() => new MarketMaker(cfg), { quoteFv: (id, now, fv) => ({ ...fv, p: mm.fvAt(id, now + 5_000) ?? fv.p }) });
    const adv = (r: BacktestRunner) => sum(r, "base", (x) => x.pnlAdverse) / Math.max(1, sum(r, "base", (x) => x.volumeFilled));
    expect(adv(fs)).toBeGreaterThan(0);
    expect(adv(fs)).toBeGreaterThan(adv(mm));
  });

  it("7. identical input + config ⇒ identical results", async () => {
    expect(digest(await run(() => new MarketMaker(cfg)))).toBe(digest(await run(() => new MarketMaker(cfg))));
  });
});
