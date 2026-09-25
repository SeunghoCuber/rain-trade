// Sanity-check suite (PLAN.md §9): `pnpm sanity [--from ISO] [--to ISO] [--config path]`
// Runs the simulator several times over the same recorded data and fails (exit 1) on any violated
// invariant. FLAG = assumption to watch, not a failure.

import { DuckDBInstance } from "@duckdb/node-api";
import { loadConfig, type FillMode } from "@rain/pm-harness-core";
import { computeDayHealth } from "@rain/pm-harness-store";
import { MarketMaker, NoQuote, RandomQuote, type BacktestRunner } from "@rain/pm-harness-strategy";
import { backtest } from "./backtest-lib.ts";

type Status = "PASS" | "FAIL" | "FLAG";
interface Check {
  n: number;
  name: string;
  status: Status;
  detail: string;
}

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const cfg = loadConfig(opt("--config") ?? "config/default.yaml");
const fromMs = opt("--from") ? Date.parse(opt("--from")!) : undefined;
// default: closed hours only, so every run in the suite sees the same data while the recorder appends
const toMs = opt("--to") ? Date.parse(opt("--to")!) : Math.floor(Date.now() / 3_600_000) * 3_600_000;
const range = { ...(fromMs !== undefined ? { fromMs } : {}), toMs };

const inst = await DuckDBInstance.create(":memory:");
const conn = await inst.connect();
const run = async (label: string, strategy: (m: FillMode) => MarketMaker | NoQuote | RandomQuote, extra: Partial<Parameters<typeof backtest>[0]> = {}) => {
  const t0 = Date.now();
  const out = await backtest({ cfg, conn, runId: `sanity-${label}`, strategy, replay: range, write: false, ...extra });
  console.log(`  ran ${label.padEnd(10)} ${out.runner.events.toLocaleString()} events, ${out.runner.results.length} market×mode results, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  return out;
};
const perMode = (r: BacktestRunner, mode: FillMode) => {
  const rs = r.results.filter((x) => x.mode === mode);
  const sum = (f: (x: (typeof rs)[number]) => number) => rs.reduce((a, x) => a + f(x), 0);
  const vol = sum((x) => x.volumeFilled);
  return { rs, vol, trading: sum((x) => x.pnlTrading), spread: sum((x) => x.pnlSpread), adverse: sum((x) => x.pnlAdverse), fills: sum((x) => x.fills) };
};
const cents = (x: number, vol: number) => (vol ? `${((100 * x) / vol).toFixed(3)}¢/share` : "no volume");

console.log(`running backtests on data up to ${new Date(toMs).toISOString()}…`);
const mm = await run("mm", () => new MarketMaker(cfg));
const mm2 = await run("mm-again", () => new MarketMaker(cfg));
const none = await run("none", () => new NoQuote());
const random = await run("random", (m) => new RandomQuote(cfg, `sanity-${m}`));
const foresight = await run("foresight", () => new MarketMaker(cfg), {
  quoteFv: (id, now, fv) => ({ ...fv, p: mm.runner.fvAt(id, now + 5_000) ?? fv.p }),
});

const checks: Check[] = [];
const add = (n: number, name: string, ok: boolean | "flag", detail: string) => checks.push({ n, name, status: ok === "flag" ? "FLAG" : ok ? "PASS" : "FAIL", detail });

// 1. decomposition identity
const maxErr = Math.max(0, ...[...mm.runner.results, ...random.runner.results, ...foresight.runner.results].map((r) => r.decompError));
add(1, "decomposition identity", maxErr <= 1e-9, `max |trading − (spread + adverse + inventory)| = ${maxErr.toExponential(2)}`);

// 2. zero strategy
const z = none.runner.results;
const zAbs = Math.max(0, ...z.map((r) => Math.abs(r.pnlTrading) + Math.abs(r.rebateEst) + r.volumeFilled));
add(2, "zero-strategy PnL is exactly 0", z.length > 0 && zAbs === 0 && none.runner.allFills().length === 0, `${z.length} market×mode results, max |PnL|+volume = ${zAbs}`);

// 3. random quotes: spread capture + adverse selection must not be positive
const rnd = (["base", "pessimistic"] as const).map((m) => ({ m, ...perMode(random.runner, m) }));
add(
  3,
  "random quotes lose after adverse selection",
  rnd.every((x) => x.vol > 0 && x.spread + x.adverse <= 0),
  rnd.map((x) => `${x.m}: spread+adverse ${cents(x.spread + x.adverse, x.vol)} over ${x.fills} fills`).join("; "),
);

// 4. perfect foresight: knowing FV 5 s ahead must earn clearly positive adverse-selection PnL
const fs = perMode(foresight.runner, "base");
const mmBase = perMode(mm.runner, "base");
add(
  4,
  "perfect foresight earns adverse-selection PnL",
  fs.vol > 0 && fs.adverse > 0 && fs.adverse / fs.vol > mmBase.adverse / Math.max(1, mmBase.vol),
  `base: foresight adverse ${cents(fs.adverse, fs.vol)} vs mm ${cents(mmBase.adverse, mmBase.vol)}`,
);

// 5. settlement cross-check: our TWAP outcome vs official
const days = new Set<string>();
for (const r of mm.runner.results) days.add(new Date(r.windowStart).toISOString().slice(0, 10));
let compared = 0, agree = 0;
for (const d of days) {
  for (const h of (await computeDayHealth(cfg, d)).markets) {
    if (!h.outcome || !h.ourOutcome) continue;
    compared++;
    if (h.outcome === h.ourOutcome) agree++;
  }
}
add(5, "settlement matches official ≥ 99.9%", compared > 0 && agree / compared >= 0.999, `${agree}/${compared} markets agree`);

// 6. size impact: quoteSize vs displayed size at our level (or the best level when we are alone)
const impacts = mm.runner.quotes.flatMap((q) => [q.bidImpact, q.askImpact]).filter((x): x is number => x !== null);
const small = impacts.filter((x) => x < 0.2).length;
const share = impacts.length ? small / impacts.length : 0;
add(6, "quoteSize < 20% of level size in ≥ 95% of quotes", share >= 0.95 ? true : "flag", `${(100 * share).toFixed(1)}% of ${impacts.length} quote levels (quotes at a new, empty level are not counted)`);

// 7. determinism
add(7, "replay determinism", mm.digest === mm2.digest, `run 1 ${mm.digest.slice(0, 16)} vs run 2 ${mm2.digest.slice(0, 16)}`);

conn.closeSync();
inst.closeSync();
console.log("\n#  status  check                                              detail");
for (const c of checks) console.log(`${c.n}  ${c.status.padEnd(6)}  ${c.name.padEnd(50)} ${c.detail}`);
const failed = checks.filter((c) => c.status === "FAIL");
console.log(failed.length ? `\n${failed.length} check(s) FAILED` : "\nall checks passed");
process.exit(failed.length ? 1 : 0);
