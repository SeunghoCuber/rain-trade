// Fair value calibration (PLAN.md §7.5): `pnpm fv:calibrate [--from ISO] [--to ISO]`
// Samples our FV and the Polymarket mid once per second inside every market window, then compares
// both against the official outcome: Brier score, reliability by FV bucket, split by time left,
// and lead/lag of FV changes vs mid changes. Samples go to data/analysis/fv_samples.parquet (V8).

import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { loadConfig, MarketStates, type Token } from "@rain/pm-harness-core";
import { replay, writeParquet } from "@rain/pm-harness-store";
import { FairValueEngine } from "@rain/pm-harness-strategy";

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const cfg = loadConfig(opt("--config") ?? "config/default.yaml");
const fromMs = opt("--from") ? Date.parse(opt("--from")!) : undefined;
const toMs = opt("--to") ? Date.parse(opt("--to")!) : undefined;

interface Sample {
  marketId: string;
  t: number;
  secsLeft: number;
  fv: number;
  mid: number | null;
  sigma: number;
}

const inst = await DuckDBInstance.create(":memory:");
const conn = await inst.connect();
const fvEng = new FairValueEngine(cfg);
const states = new MarketStates();
const samples: Sample[] = [];
const lastSampleSec = new Map<string, number>();
const outcomes = new Map<string, Token>();

for await (const ev of replay(conn, cfg.recorder.dataDir, { rawOnly: true, ...(fromMs ? { fromMs } : {}), ...(toMs ? { toMs } : {}) })) {
  fvEng.onEvent(ev);
  states.apply(ev);
  if (ev.kind === "resolution") outcomes.set(ev.marketId!, ev.payload.outcome);
  const now = Number(ev.recvTs / 1_000_000n);
  const sec = Math.floor(now / 1000);
  for (const [id, s] of states.markets) {
    const m = s.meta;
    if (!m || now < m.windowStart || now >= m.windowEnd || lastSampleSec.get(id) === sec) continue;
    lastSampleSec.set(id, sec);
    const fv = fvEng.fairValue(id, now);
    if (!fv) continue;
    const q = s.book.quote("UP");
    const mid = s.synced && q.bid !== null && q.ask !== null && q.ask - q.bid <= 0.05 ? (q.bid + q.ask) / 2 : null;
    samples.push({ marketId: id, t: now, secsLeft: (m.windowEnd - now) / 1000, fv: fv.p, mid, sigma: fv.sigma });
  }
}

const labeled = samples.filter((s) => outcomes.has(s.marketId));
const y = (s: Sample) => (outcomes.get(s.marketId) === "UP" ? 1 : 0);
const brier = (xs: Sample[], f: (s: Sample) => number | null) => {
  const v = xs.filter((s) => f(s) !== null);
  return { n: v.length, brier: v.reduce((a, s) => a + (f(s)! - y(s)) ** 2, 0) / Math.max(1, v.length) };
};
const both = labeled.filter((s) => s.mid !== null);
const buckets: [string, (s: Sample) => boolean][] = [
  ["τ > 10 min", (s) => s.secsLeft > 600],
  ["5–10 min", (s) => s.secsLeft > 300 && s.secsLeft <= 600],
  ["< 5 min", (s) => s.secsLeft <= 300],
  ["all", () => true],
];

console.log(`\nmarkets with FV samples: ${new Set(samples.map((s) => s.marketId)).size}, resolved: ${new Set(labeled.map((s) => s.marketId)).size}, samples: ${labeled.length.toLocaleString()} (with a usable mid: ${both.length.toLocaleString()})\n`);
console.log("Brier score (lower is better), on seconds where both FV and mid exist:");
console.log("bucket        n        FV       PM mid   FV − mid");
for (const [name, f] of buckets) {
  const xs = both.filter(f);
  const a = brier(xs, (s) => s.fv).brier, b = brier(xs, (s) => s.mid).brier;
  console.log(`${name.padEnd(12)}${String(xs.length).padStart(8)}  ${a.toFixed(4)}   ${b.toFixed(4)}   ${(a - b >= 0 ? "+" : "") + (a - b).toFixed(4)}`);
}

console.log("\nReliability (all τ): FV bucket → mean FV, mean mid, actual UP rate");
for (let b = 0; b < 10; b++) {
  const xs = both.filter((s) => Math.min(9, Math.floor(s.fv * 10)) === b);
  if (!xs.length) continue;
  const mean = (f: (s: Sample) => number) => xs.reduce((a, s) => a + f(s), 0) / xs.length;
  console.log(`  ${(b / 10).toFixed(1)}–${((b + 1) / 10).toFixed(1)}  n=${String(xs.length).padStart(6)}  FV ${mean((s) => s.fv).toFixed(3)}  mid ${mean((s) => s.mid!).toFixed(3)}  actual ${mean(y).toFixed(3)}  markets ${new Set(xs.map((s) => s.marketId)).size}`);
}

// lead/lag: corr(ΔFV_t, Δmid_{t+k}); positive peak at k > 0 means FV moves first
const byMarket = new Map<string, Sample[]>();
for (const s of both) (byMarket.get(s.marketId) ?? byMarket.set(s.marketId, []).get(s.marketId)!).push(s);
console.log("\nLead/lag corr(ΔFV_t, Δmid_t+k), 1 s steps (peak at k > 0 ⇒ FV leads):");
const line: string[] = [];
for (const k of [-5, -3, -2, -1, 0, 1, 2, 3, 5]) {
  let sxy = 0, sxx = 0, syy = 0;
  for (const xs of byMarket.values()) {
    for (let i = 1; i < xs.length; i++) {
      const j = i + k;
      if (j < 1 || j >= xs.length) continue;
      const dx = xs[i]!.fv - xs[i - 1]!.fv, dy = xs[j]!.mid! - xs[j - 1]!.mid!;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
  }
  line.push(`k=${k}: ${(sxy / Math.sqrt(sxx * syy)).toFixed(3)}`);
}
console.log("  " + line.join("  "));

const out = join(cfg.recorder.dataDir, "analysis", "fv_samples.parquet");
await writeParquet(
  conn,
  out,
  [["market_id", "VARCHAR"], ["t", "BIGINT"], ["secs_left", "DOUBLE"], ["fv", "DOUBLE"], ["mid", "DOUBLE"], ["sigma", "DOUBLE"], ["outcome", "INTEGER"]],
  samples.map((s) => [s.marketId, s.t, s.secsLeft, s.fv, s.mid, s.sigma, outcomes.has(s.marketId) ? y(s) : null]),
);
console.log(`\nwrote ${samples.length.toLocaleString()} samples → ${out}`);
conn.closeSync();
inst.closeSync();
