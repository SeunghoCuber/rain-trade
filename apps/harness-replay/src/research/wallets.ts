// Wallet research: `pnpm research:wallets [--is 0.6] [--min-markets 15] [--top 10]`
// Is anyone beating the BTC 15m markets we recorded, persistently, in a way we could copy?
//  1. For every resolved market we recorded, download all TAKER trades (Polymarket data API,
//     takerOnly=true: the taker's wallet, side, token, price, size). Cached in data/research/trades/.
//  2. Score each taker trade against the official outcome, after the taker fee:
//       buy:  (payoff − price)·size − fee      sell: (price − payoff)·size − fee
//  3. Rank wallets on the EARLIER markets (in-sample) by t-stat of PnL per market; report how the
//     top ones do on the LATER markets (out-of-sample) — persistence, not luck.
//  4. Copy delay: for top wallets, the edge had we copied each trade Δ seconds later at the price
//     the next taker on the same token and side actually paid (Δ = 0, 2, 5, 10, 30, 60 s).
// Writes data/research/wallets.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "@rain/pm-harness-core";
import { openStore } from "@rain/pm-harness-store";

const args = process.argv.slice(2);
const opt = (n: string, d: string) => (args.includes(n) ? args[args.indexOf(n) + 1]! : d);
const cfg = loadConfig(opt("--config", "config/default.yaml"));
const IS_FRAC = Number(opt("--is", "0.6"));
const MIN_MARKETS = Number(opt("--min-markets", "15"));
const TOP = Number(opt("--top", "10"));
const DELAYS = [0, 2, 5, 10, 30, 60];
const dataDir = cfg.recorder.dataDir;
const cacheDir = join(dataDir, "research", "trades");
mkdirSync(cacheDir, { recursive: true });
const fee = (size: number, p: number) => size * cfg.venue.feeSchedule.rate * Math.pow(p * (1 - p), cfg.venue.feeSchedule.exponent);

interface ApiTrade {
  proxyWallet: string;
  side: "BUY" | "SELL";
  outcomeIndex: number; // 0 = Up, 1 = Down
  price: number;
  size: number;
  timestamp: number; // s
  name?: string;
  pseudonym?: string;
}

interface Market {
  marketId: string;
  slug: string;
  windowStart: number;
  outcome: "UP" | "DOWN";
}

async function fetchTakerTrades(marketId: string): Promise<ApiTrade[]> {
  const file = join(cacheDir, `${marketId}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as ApiTrade[];
  const out: ApiTrade[] = [];
  for (let offset = 0; offset < 50_000; offset += 500) {
    let page: ApiTrade[] | null = null;
    for (let attempt = 0; attempt < 8 && page === null; attempt++) {
      const res = await fetch(`https://data-api.polymarket.com/trades?market=${marketId}&limit=500&offset=${offset}&takerOnly=true`, {
        headers: { "User-Agent": "raintrade-research" },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429) await new Promise((r) => setTimeout(r, 4_000 * (attempt + 1)));
      else if (!res.ok) throw new Error(`${marketId}: HTTP ${res.status}`);
      else page = (await res.json()) as ApiTrade[];
    }
    if (!page) throw new Error(`${marketId}: rate limited`);
    out.push(...page);
    await new Promise((r) => setTimeout(r, 700)); // stay well under the rate limit
    if (page.length < 500) break;
  }
  writeFileSync(file, JSON.stringify(out.map((t) => ({ proxyWallet: t.proxyWallet, side: t.side, outcomeIndex: t.outcomeIndex, price: t.price, size: t.size, timestamp: t.timestamp, name: t.name, pseudonym: t.pseudonym }))));
  return out;
}

// 1. markets
const store = await openStore(dataDir);
const markets = (
  (await store.conn.runAndReadAll("SELECT market_id, slug, window_start, outcome FROM markets WHERE outcome IS NOT NULL ORDER BY window_start")).getRowObjectsJS() as {
    market_id: string;
    slug: string;
    window_start: bigint;
    outcome: "UP" | "DOWN";
  }[]
).map((r): Market => ({ marketId: r.market_id, slug: r.slug, windowStart: Number(r.window_start), outcome: r.outcome }));
store.close();
console.log(`${markets.length} resolved markets; downloading taker trades (cached after the first run)…`);

const tradesBy = new Map<string, ApiTrade[]>();
for (const [i, m] of markets.entries()) {
  tradesBy.set(m.marketId, await fetchTakerTrades(m.marketId));
  if ((i + 1) % 20 === 0) console.log(`  ${i + 1}/${markets.length}`);
}

// 2. score trades
interface Scored {
  wallet: string;
  marketId: string;
  ts: number;
  token: 0 | 1;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  pnl: number;
}
const label = new Map<string, string>();
const scored: Scored[] = [];
for (const m of markets) {
  const winner = m.outcome === "UP" ? 0 : 1;
  for (const t of tradesBy.get(m.marketId) ?? []) {
    const payoff = t.outcomeIndex === winner ? 1 : 0;
    const d = t.side === "BUY" ? 1 : -1;
    scored.push({ wallet: t.proxyWallet, marketId: m.marketId, ts: t.timestamp, token: t.outcomeIndex as 0 | 1, side: t.side, price: t.price, size: t.size, pnl: d * (payoff - t.price) * t.size - fee(t.size, t.price) });
    if (!label.has(t.proxyWallet)) label.set(t.proxyWallet, t.name || t.pseudonym || "");
  }
}

const split = markets[Math.floor(markets.length * IS_FRAC)]!.windowStart;
const isMarket = new Map(markets.map((m) => [m.marketId, m.windowStart < split]));

interface WalletStats {
  wallet: string;
  label: string;
  markets: number;
  trades: number;
  volume: number;
  pnl: number;
  centsPerShare: number;
  meanPerMarket: number;
  t: number;
}
function stats(rows: Scored[]): WalletStats[] {
  const by = new Map<string, Scored[]>();
  for (const r of rows) (by.get(r.wallet) ?? by.set(r.wallet, []).get(r.wallet)!).push(r);
  return [...by].map(([wallet, rs]) => {
    const perMarket = new Map<string, number>();
    for (const r of rs) perMarket.set(r.marketId, (perMarket.get(r.marketId) ?? 0) + r.pnl);
    const xs = [...perMarket.values()];
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)) : NaN;
    const volume = rs.reduce((a, r) => a + r.size, 0);
    const pnl = rs.reduce((a, r) => a + r.pnl, 0);
    return { wallet, label: label.get(wallet) ?? "", markets: xs.length, trades: rs.length, volume, pnl, centsPerShare: (100 * pnl) / volume, meanPerMarket: mean, t: sd > 0 ? mean / (sd / Math.sqrt(xs.length)) : NaN };
  });
}

const isStats = stats(scored.filter((r) => isMarket.get(r.marketId)));
const oosStats = new Map(stats(scored.filter((r) => !isMarket.get(r.marketId))).map((s) => [s.wallet, s]));
const eligible = isStats.filter((s) => s.markets >= MIN_MARKETS && Number.isFinite(s.t));
const top = [...eligible].sort((a, b) => b.t - a.t).slice(0, TOP);

// 3b. persistence across all eligible wallets: does in-sample edge predict out-of-sample edge?
const both = eligible.map((s) => ({ is: s.centsPerShare, oos: oosStats.get(s.wallet) })).filter((x) => x.oos && x.oos.markets >= 5) as { is: number; oos: WalletStats }[];
const rank = (xs: number[]) => {
  const o = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  o.forEach(([, i], k) => (r[i] = k));
  return r;
};
const spearman = (() => {
  if (both.length < 5) return NaN;
  const a = rank(both.map((x) => x.is)), b = rank(both.map((x) => x.oos.centsPerShare));
  const n = a.length, ma = (n - 1) / 2;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i]! - ma) * (b[i]! - ma);
    da += (a[i]! - ma) ** 2;
    db += (b[i]! - ma) ** 2;
  }
  return num / Math.sqrt(da * db);
})();

// 4. copy delay: price the next taker on the same token and side paid ≥ Δ s later
const byMarketTokenSide = new Map<string, Scored[]>();
for (const r of scored) {
  const k = `${r.marketId}|${r.token}|${r.side}`;
  (byMarketTokenSide.get(k) ?? byMarketTokenSide.set(k, []).get(k)!).push(r);
}
for (const xs of byMarketTokenSide.values()) xs.sort((a, b) => a.ts - b.ts);
const winnerOf = new Map(markets.map((m) => [m.marketId, m.outcome === "UP" ? 0 : 1]));
function delayCurve(wallets: Set<string>, oosOnly: boolean) {
  return DELAYS.map((delay) => {
    let pnl = 0, vol = 0, n = 0;
    for (const r of scored) {
      if (!wallets.has(r.wallet) || (oosOnly && isMarket.get(r.marketId))) continue;
      let p = r.price;
      if (delay > 0) {
        const xs = byMarketTokenSide.get(`${r.marketId}|${r.token}|${r.side}`)!;
        const next = xs.find((x) => x.ts >= r.ts + delay);
        if (!next) continue; // nothing traded later: could not have copied
        p = next.price;
      }
      const payoff = r.token === winnerOf.get(r.marketId) ? 1 : 0;
      const d = r.side === "BUY" ? 1 : -1;
      pnl += d * (payoff - p) * r.size - fee(r.size, p);
      vol += r.size;
      n++;
    }
    return { delaySec: delay, trades: n, centsPerShare: vol ? (100 * pnl) / vol : NaN, pnl };
  });
}
const topSet = new Set(top.map((s) => s.wallet));

// report
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "—");
const short = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`;
console.log(
  `\n${scored.length.toLocaleString()} taker trades by ${new Set(scored.map((r) => r.wallet)).size.toLocaleString()} wallets over ${markets.length} markets. ` +
    `In-sample: markets before ${new Date(split).toISOString()} (${[...isMarket.values()].filter(Boolean).length}); out-of-sample: the rest.`,
);
console.log(`\nTop ${TOP} wallets by in-sample t-stat (≥ ${MIN_MARKETS} in-sample markets), and how they did out-of-sample:`);
console.log("wallet          name                  IS mkts  IS $      IS ¢/sh  IS t   | OOS mkts  OOS $     OOS ¢/sh  OOS t");
for (const s of top) {
  const o = oosStats.get(s.wallet);
  console.log(
    `${short(s.wallet)}  ${s.label.slice(0, 20).padEnd(20)}${String(s.markets).padStart(8)}${f(s.pnl, 0).padStart(9)}${f(s.centsPerShare).padStart(9)}${f(s.t).padStart(6)}   |` +
      `${String(o?.markets ?? 0).padStart(9)}${f(o?.pnl ?? NaN, 0).padStart(9)}${f(o?.centsPerShare ?? NaN).padStart(10)}${f(o?.t ?? NaN).padStart(7)}`,
  );
}
const oosTop = top.map((s) => oosStats.get(s.wallet)).filter((x): x is WalletStats => !!x);
const sumP = oosTop.reduce((a, s) => a + s.pnl, 0), sumV = oosTop.reduce((a, s) => a + s.volume, 0);
const allOos = [...oosStats.values()];
const allP = allOos.reduce((a, s) => a + s.pnl, 0), allV = allOos.reduce((a, s) => a + s.volume, 0);
console.log(`\nOut-of-sample, top ${TOP} combined: $${f(sumP, 0)} on ${f(sumV, 0)} shares = ${f((100 * sumP) / sumV)}¢/share   vs all takers: ${f((100 * allP) / allV)}¢/share`);
console.log(`Persistence: Spearman rank correlation of in-sample vs out-of-sample ¢/share across ${both.length} wallets = ${f(spearman, 3)} (≈0 ⇒ past winners are not future winners)`);
const curveAll = delayCurve(topSet, false), curveOos = delayCurve(topSet, true);
console.log("\nCopying the top wallets Δ seconds late (at the next same-side taker price, after fees), ¢/share:");
console.log("  delay:          " + DELAYS.map((d) => `${d}s`.padStart(8)).join(""));
console.log("  all markets:    " + curveAll.map((c) => f(c.centsPerShare).padStart(8)).join(""));
console.log("  out-of-sample:  " + curveOos.map((c) => f(c.centsPerShare).padStart(8)).join(""));

mkdirSync(join(dataDir, "research"), { recursive: true });
writeFileSync(
  join(dataDir, "research", "wallets.json"),
  JSON.stringify({ createdAt: new Date().toISOString(), markets: markets.length, splitMs: split, minMarkets: MIN_MARKETS, top: top.map((s) => ({ ...s, oos: oosStats.get(s.wallet) ?? null })), spearman, delayCurve: { all: curveAll, oos: curveOos } }, null, 2),
);
console.log(`\nwrote ${join(dataDir, "research", "wallets.json")}`);
