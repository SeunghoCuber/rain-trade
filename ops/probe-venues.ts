// Measure what matters for choosing a server region: REST round-trip to each venue, WebSocket
// connect time, how late each feed's messages arrive (local clock − exchange timestamp), and
// whether anything is geo-blocked. Run on a candidate machine:  node ops/probe-venues.ts [seconds=20]
// Feed lag includes clock offset; check the clock first (`chronyc tracking` on Linux).

const seconds = Number(process.argv[2] ?? 20);
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1]! : NaN);
const p90 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.9)]! : NaN);
const f = (x: number) => (Number.isFinite(x) ? `${Math.round(x)}` : "—");

async function rest(name: string, url: string, n = 5) {
  const rtts: number[] = [];
  let status = 0;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    try {
      const r = await fetch(url, { headers: { "User-Agent": "raintrade-probe" }, signal: AbortSignal.timeout(10_000) });
      await r.arrayBuffer();
      status = r.status;
      if (i > 0) rtts.push(performance.now() - t0); // first request pays DNS + TLS
    } catch (e) {
      return { name, status: `ERR ${(e as Error).message}`, median: NaN, p90: NaN };
    }
  }
  return { name, status: String(status) + (status === 451 ? " (GEO-BLOCKED)" : ""), median: median(rtts), p90: p90(rtts) };
}

interface WsProbe {
  name: string;
  url: string;
  subscribe?: string;
  ping?: string;
  /** exchange timestamp (ms) of a message, if it carries one */
  ts: (msg: unknown) => number | null;
}

function ws(p: WsProbe): Promise<{ name: string; connectMs: number; msgs: number; lagMedian: number; lagP90: number; error?: string }> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let connectMs = NaN;
    let msgs = 0;
    const lags: number[] = [];
    const sock = new WebSocket(p.url);
    let ping: ReturnType<typeof setInterval> | undefined;
    const done = (error?: string) => {
      clearInterval(ping);
      try {
        sock.close();
      } catch {
        /* closed */
      }
      resolve({ name: p.name, connectMs, msgs, lagMedian: median(lags), lagP90: p90(lags), ...(error ? { error } : {}) });
    };
    sock.onopen = () => {
      connectMs = performance.now() - t0;
      if (p.subscribe) sock.send(p.subscribe);
      if (p.ping) ping = setInterval(() => sock.send(p.ping!), 5000);
    };
    sock.onmessage = (e) => {
      const now = Date.now();
      msgs++;
      try {
        const parsed = JSON.parse(String(e.data)) as unknown;
        for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
          const ts = p.ts(m);
          if (ts) lags.push(now - ts);
        }
      } catch {
        /* PONG etc. */
      }
    };
    sock.onerror = () => done("connection error");
    setTimeout(() => done(), seconds * 1000);
  });
}

async function main() {
  // live market for the CLOB subscription
  const now = Math.floor(Date.now() / 1000);
  const slug = `btc-updown-15m-${now - (now % 900)}`;
  const ev = (await (await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`)).json()) as { markets: { clobTokenIds: string }[] }[];
  const tokens = JSON.parse(ev[0]!.markets[0]!.clobTokenIds) as string[];

  console.log(`probing for ${seconds}s from ${Intl.DateTimeFormat().resolvedOptions().timeZone}…\n`);
  const [restResults, wsResults] = await Promise.all([
    Promise.all([
      rest("gamma REST", `https://gamma-api.polymarket.com/events?slug=${slug}`),
      rest("clob REST", `https://clob.polymarket.com/book?token_id=${tokens[0]}`),
      rest("binance api", "https://api.binance.com/api/v3/ping"),
      rest("binance vision", "https://data-api.binance.vision/api/v3/ping"),
      rest("coinbase REST", "https://api.exchange.coinbase.com/products/BTC-USD/ticker"),
    ]),
    Promise.all([
      ws({
        name: "clob WS (trades)",
        url: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
        subscribe: JSON.stringify({ assets_ids: tokens, type: "market" }),
        ping: "PING",
        ts: (m) => ((m as { event_type?: string }).event_type ? Number((m as { timestamp: string }).timestamp) : null),
      }),
      ws({
        name: "rtds chainlink",
        url: "wss://ws-live-data.polymarket.com",
        subscribe: JSON.stringify({ action: "subscribe", subscriptions: [{ topic: "crypto_prices_chainlink", type: "*", filters: '{"symbol":"btc/usd"}' }] }),
        ping: "PING",
        ts: (m) => ((m as { type?: string }).type === "update" ? (m as { payload: { timestamp: number } }).payload.timestamp : null),
      }),
      ws({
        name: "binance.com WS",
        url: "wss://stream.binance.com:9443/stream?streams=btcusdt@aggTrade",
        ts: (m) => (m as { data?: { T?: number } }).data?.T ?? null,
      }),
      ws({
        name: "binance vision WS",
        url: "wss://data-stream.binance.vision/stream?streams=btcusdt@aggTrade",
        ts: (m) => (m as { data?: { T?: number } }).data?.T ?? null,
      }),
      ws({
        name: "coinbase WS",
        url: "wss://ws-feed.exchange.coinbase.com",
        subscribe: JSON.stringify({ type: "subscribe", product_ids: ["BTC-USD"], channels: ["ticker"] }),
        ts: (m) => ((m as { type?: string }).type === "ticker" ? Date.parse((m as { time: string }).time) : null),
      }),
    ]),
  ]);

  console.log("REST                status               rtt median  rtt p90 (ms)");
  for (const r of restResults) console.log(`${r.name.padEnd(20)}${r.status.padEnd(21)}${f(r.median).padStart(10)}${f(r.p90).padStart(9)}`);
  console.log("\nWebSocket           connect(ms)  msgs   lag median  lag p90 (ms, local − exchange ts)");
  for (const r of wsResults) {
    console.log(`${r.name.padEnd(20)}${f(r.connectMs).padStart(11)}${String(r.msgs).padStart(6)}${f(r.lagMedian).padStart(13)}${f(r.lagP90).padStart(9)}${r.error ? `   ${r.error}` : ""}`);
  }
  console.log("\nLower CLOB REST rtt / CLOB lag = closer to Polymarket. Chainlink lag is ~1.5 s everywhere (upstream).");
}

await main();
