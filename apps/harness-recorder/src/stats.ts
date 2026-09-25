// Recording health for one UTC day: `node src/stats.ts [YYYY-MM-DD] [config]`.
// Phase 1 exit check: every expected market is recorded, gap-free, resolved, and our TWAP matches Gamma.
// Coverage holes are measured from the data itself (inter-arrival times), so recorder restarts,
// crashes and sleep show up even though no feed_gap event could be written for them.

import { createReadStream, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { chainlinkTwap, loadConfig, type ChainlinkTick } from "@rain/pm-harness-core";

interface Row {
  kind: string;
  marketId?: string;
  exchangeTs: number;
  recvTs: string;
  payload: Record<string, unknown>;
}

interface MarketStats {
  slug: string;
  windowStart: number;
  windowEnd: number;
  firstClobMs: number | null;
  lastClobMs: number | null;
  /** largest in-window interval without any CLOB event for this market (incl. window edges) */
  clobHoleMs: number;
  deltas: number;
  trades: number;
  snapshots: number;
  maxClobGapMs: number;
  resolution: { outcome: string; priceToBeat: number; finalPrice: number } | null;
}

const day = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const cfg = loadConfig(process.argv[3] ?? "config/default.yaml");
const dur = cfg.market.durationSec * 1000;
const dayStart = Date.parse(`${day}T00:00:00Z`);
const nextDay = new Date(dayStart + 86_400_000).toISOString().slice(0, 10);

function filesFor(d: string): string[] {
  const dir = join(cfg.recorder.dataDir, "raw", d);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ndjson") || f.endsWith(".ndjson.gz"))
    .sort()
    .map((f) => join(dir, f));
}

async function* rows(file: string): AsyncGenerator<Row> {
  const input = file.endsWith(".gz") ? createReadStream(file).pipe(createGunzip()) : createReadStream(file);
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!line) continue;
    try {
      yield JSON.parse(line) as Row;
    } catch {
      // truncated last line of a file that was being written when the process died
    }
  }
}

const recvMs = (r: Row) => Number(BigInt(r.recvTs) / 1_000_000n);

const markets = new Map<string, MarketStats>();
const ticks = new Map<number, bigint>();
const globalGaps: { feed: string; endMs: number; gapMs: number; reason: string }[] = [];
/** Binance bookTicker is continuous, so holes in its arrivals are holes in the recording itself. */
const recorderHoles: { start: number; end: number }[] = [];
let lastBinanceMs: number | null = null;
const kinds: Record<string, number> = {};
let lines = 0;

// include the next day's files: late resolutions for the last windows of the day land there
for (const file of [...filesFor(day), ...filesFor(nextDay)]) {
  for await (const r of rows(file)) {
    lines++;
    kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
    const m = r.marketId ? markets.get(r.marketId) : undefined;
    switch (r.kind) {
      case "market_open": {
        const p = r.payload as { slug: string; windowStart: number; windowEnd: number };
        if (!markets.has(r.marketId!)) {
          markets.set(r.marketId!, {
            slug: p.slug,
            windowStart: p.windowStart,
            windowEnd: p.windowEnd,
            firstClobMs: null,
            lastClobMs: null,
            clobHoleMs: 0,
            deltas: 0,
            trades: 0,
            snapshots: 0,
            maxClobGapMs: 0,
            resolution: null,
          });
        }
        break;
      }
      case "book_delta":
      case "book_snapshot":
      case "trade":
        if (!m) break;
        {
          const t = recvMs(r);
          if (m.firstClobMs === null) m.firstClobMs = t;
          const from = Math.max(m.lastClobMs ?? m.windowStart, m.windowStart);
          const to = Math.min(t, m.windowEnd);
          if (to > from) m.clobHoleMs = Math.max(m.clobHoleMs, to - from);
          m.lastClobMs = t;
        }
        if (r.kind === "book_delta") m.deltas++;
        else if (r.kind === "trade") m.trades++;
        else m.snapshots++;
        break;
      case "feed_gap": {
        const p = r.payload as { feed: string; gapMs: number; reason: string };
        if (m) m.maxClobGapMs = Math.max(m.maxClobGapMs, p.gapMs);
        else globalGaps.push({ feed: p.feed, endMs: recvMs(r), gapMs: p.gapMs, reason: p.reason });
        break;
      }
      case "spot": {
        if ((r.payload as { source: string }).source !== "binance") break;
        const t = recvMs(r);
        if (lastBinanceMs !== null && t - lastBinanceMs > cfg.recorder.maxGapMs) recorderHoles.push({ start: lastBinanceMs, end: t });
        lastBinanceMs = t;
        break;
      }
      case "res_price": {
        const p = r.payload as { symbol: string; price: number; scaled?: string };
        if (p.symbol !== `${cfg.market.coin}/usd`) break;
        // backfill ticks have no full-accuracy value; never let them override a live one
        if (p.scaled) ticks.set(r.exchangeTs, BigInt(p.scaled));
        else if (!ticks.has(r.exchangeTs)) ticks.set(r.exchangeTs, BigInt(Math.round(p.price * 1e8)) * 10n ** 10n);
        break;
      }
      case "resolution":
        if (m) m.resolution = r.payload as MarketStats["resolution"];
        break;
    }
  }
}

const tickList: ChainlinkTick[] = [...ticks].map(([timestampMs, scaled]) => ({ timestampMs, scaled }));
const twapAt = (b: number) => chainlinkTwap(tickList, b, cfg.settlement.twapWindow);

const inDay = [...markets.values()]
  .filter((m) => m.windowStart >= dayStart && m.windowStart < dayStart + 86_400_000)
  .sort((a, b) => a.windowStart - b.windowStart);
const expected = Math.round(86_400_000 / dur);

const fmt = (x: number | null | undefined, d = 2) => (x == null ? "—" : x.toFixed(d));
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const flagsCount: Record<string, number> = {};

console.log(`\n${day}: ${lines.toLocaleString()} events read  ${JSON.stringify(kinds)}\n`);
console.log("window  deltas   trades  snaps  late(s)  clobHole  recHole  feedGap  clTicks  outcome   ourS0−ptb    ourS1−final  flags");
for (const m of inDay) {
  // close out the tail of the window (recording stopped before windowEnd)
  const tailFrom = Math.max(m.lastClobMs ?? m.windowStart, m.windowStart);
  if (m.windowEnd > tailFrom && lastBinanceMs !== null && lastBinanceMs >= m.windowEnd) m.clobHoleMs = Math.max(m.clobHoleMs, m.windowEnd - tailFrom);
  const recHole = Math.max(
    0,
    ...recorderHoles.filter((h) => h.end > m.windowStart && h.start < m.windowEnd).map((h) => Math.min(h.end, m.windowEnd) - Math.max(h.start, m.windowStart)),
  );
  const clTicks = [...ticks.keys()].filter((t) => t >= m.windowStart && t < m.windowEnd).length;
  const lateS = m.firstClobMs === null ? null : Math.max(0, (m.firstClobMs - m.windowStart) / 1000);
  const feedGap = Math.max(
    0,
    ...globalGaps.filter((g) => g.endMs > m.windowStart && g.endMs - g.gapMs < m.windowEnd).map((g) => g.gapMs),
  );
  const s0 = twapAt(m.windowStart);
  const s1 = twapAt(m.windowEnd);
  const d0 = s0 && m.resolution ? s0.price - m.resolution.priceToBeat : null;
  const d1 = s1 && m.resolution ? s1.price - m.resolution.finalPrice : null;
  const flags: string[] = [];
  const worst = Math.max(m.clobHoleMs, recHole, m.maxClobGapMs, feedGap);
  if (Date.now() < m.windowEnd) flags.push("OPEN");
  else {
    if (m.firstClobMs === null) flags.push("NOCLOB");
    else if (lateS! > 5) flags.push("LATE");
    if (worst > cfg.recorder.maxGapMs) flags.push("GAP");
    if (clTicks < cfg.market.durationSec) flags.push("CLTICKS");
    if (!m.resolution) flags.push("NORES");
    if (s0 && s0.count < s0.expected) flags.push("S0TICKS");
    if (s1 && s1.count < s1.expected) flags.push("S1TICKS");
    if ((d0 !== null && Math.abs(d0) > 1e-6) || (d1 !== null && Math.abs(d1) > 1e-6)) flags.push("TWAPΔ");
  }
  for (const f of flags) flagsCount[f] = (flagsCount[f] ?? 0) + 1;
  console.log(
    [
      hhmm(m.windowStart).padEnd(6),
      String(m.deltas).padStart(7),
      String(m.trades).padStart(8),
      String(m.snapshots).padStart(6),
      fmt(lateS, 1).padStart(8),
      String(m.clobHoleMs).padStart(9),
      String(recHole).padStart(8),
      String(Math.max(m.maxClobGapMs, feedGap)).padStart(8),
      `${clTicks}/${cfg.market.durationSec}`.padStart(8),
      (m.resolution?.outcome ?? "—").padStart(8),
      fmt(d0, 9).padStart(12),
      fmt(d1, 9).padStart(14),
      "  " + flags.join(","),
    ].join(" "),
  );
}

const clean = inDay.filter((m) => m.firstClobMs !== null).length;
console.log(`\nmarkets recorded: ${inDay.length}/${expected} expected   with CLOB data: ${clean}   flags: ${JSON.stringify(flagsCount)}`);
const byFeed: Record<string, { n: number; maxMs: number }> = {};
for (const g of globalGaps) {
  const k = `${g.feed}:${g.reason}`;
  byFeed[k] = { n: (byFeed[k]?.n ?? 0) + 1, maxMs: Math.max(byFeed[k]?.maxMs ?? 0, g.gapMs) };
}
console.log(`global feed gaps: ${JSON.stringify(byFeed)}`);
