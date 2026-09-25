// Dashboard API (Phase 9): `pnpm dashboard:api [--port 8787]` — read-only JSON over data/runs + data/analysis.
// In production it also serves the built UI from apps/harness-dashboard/dist.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { analyzeRun, fvLookup, loadRun, runDir } from "@rain/pm-harness-analytics";
import { loadConfig } from "@rain/pm-harness-core";
import { createViews } from "@rain/pm-harness-store";

const args = process.argv.slice(2);
const port = Number(args.includes("--port") ? args[args.indexOf("--port") + 1] : 8787);
const cfg = loadConfig(args.includes("--config") ? args[args.indexOf("--config") + 1]! : "config/default.yaml");
const dataDir = cfg.recorder.dataDir;
const dist = new URL("../dist/", import.meta.url).pathname;
const inst = await DuckDBInstance.create(":memory:");
const conn = await inst.connect();
const sqlStr = (s: string) => `'${s.replaceAll("'", "''")}'`;
const rows = async (sql: string) => (await conn.runAndReadAll(sql)).getRowObjectsJS() as Record<string, unknown>[];
const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, (_k, v: unknown) => (typeof v === "bigint" ? Number(v) : typeof v === "number" && !Number.isFinite(v) ? null : v)));
};
const safeId = (s: string) => /^[\w.-]+$/.test(s);

async function analysisFor(runId: string): Promise<unknown> {
  const file = join(runDir(dataDir, runId), "analysis.json");
  const markets = join(runDir(dataDir, runId), "markets.parquet");
  const tz = cfg.dashboard.timeZone;
  const cached = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { timeZone?: string }) : null;
  if (!cached || cached.timeZone !== tz || statSync(file).mtimeMs < statSync(markets).mtimeMs) {
    const a = analyzeRun(runId, await loadRun(conn, dataDir, runId), { timeZone: tz });
    writeFileSync(file, JSON.stringify(a));
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

async function handle(url: URL, res: ServerResponse): Promise<void> {
  const parts = url.pathname.split("/").filter(Boolean).slice(1); // after "api"
  if (parts[0] === "runs" && parts.length === 1) {
    const root = join(dataDir, "runs");
    const runs = existsSync(root)
      ? readdirSync(root)
          .filter((d) => existsSync(join(root, d, "markets.parquet")))
          .map((d) => {
            const meta = existsSync(join(root, d, "run.json")) ? (JSON.parse(readFileSync(join(root, d, "run.json"), "utf8")) as Record<string, unknown>) : {};
            return { runId: d, createdAt: meta.createdAt ?? null, strategy: meta.strategy ?? null, events: meta.events ?? null };
          })
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      : [];
    return json(res, 200, runs);
  }
  const runId = parts[1];
  if (parts[0] === "runs" && runId && safeId(runId)) {
    const dir = runDir(dataDir, runId);
    if (!existsSync(join(dir, "markets.parquet"))) return json(res, 404, { error: "no such run" });
    const p = (f: string) => sqlStr(join(dir, f));
    if (parts[2] === "analysis") return json(res, 200, await analysisFor(runId));
    if (parts[2] === "markets" && parts.length === 3) {
      const mode = url.searchParams.get("mode") ?? "pessimistic";
      await createViews(conn, dataDir);
      return json(
        res,
        200,
        await rows(`
          SELECT r.market_id, r.slug, r.window_start, r.outcome, r.pnl_trading + r.rebate_est - r.fees AS pnl, r.pnl_adverse AS adverse,
                 r.fills, r.volume_filled AS volume, r.max_abs_inventory AS max_inv, r.quote_uptime_pct AS uptime,
                 coalesce(h.flags, 'NOHEALTH') AS flags, coalesce(h.excluded, true) AS excluded
          FROM read_parquet(${p("markets.parquet")}) r LEFT JOIN market_health h USING (market_id)
          WHERE r.mode = ${sqlStr(mode)} ORDER BY r.window_start`),
      );
    }
    if (parts[2] === "markets" && parts[3] && safeId(parts[3])) {
      const mid = sqlStr(parts[3]);
      const mode = sqlStr(url.searchParams.get("mode") ?? "pessimistic");
      const fv = (await rows(`SELECT ts, fv, mid FROM read_parquet(${p("fv.parquet")}) WHERE market_id = ${mid} ORDER BY ts`)).map((r) => ({ ts: Number(r.ts), fv: Number(r.fv), mid: r.mid == null ? null : Number(r.mid) }));
      const quotes = await rows(`SELECT ts, bid, ask, inventory FROM read_parquet(${p("quotes.parquet")}) WHERE market_id = ${mid} AND mode = ${mode} ORDER BY ts`);
      const fills = (await rows(`SELECT ts, side, price, size, inventory_before FROM read_parquet(${p("fills.parquet")}) WHERE market_id = ${mid} AND mode = ${mode} ORDER BY ts`)).map((f) => {
        const d = f.side === "BUY" ? 1 : -1;
        const fv5 = fvLookup(fv, Number(f.ts) + 5000);
        return { ...f, ts: Number(f.ts), markout5: fv5 === null ? null : 100 * d * (fv5 - Number(f.price)), inventoryAfter: Number(f.inventory_before) + d * Number(f.size) };
      });
      const meta = (await rows(`SELECT slug, window_start, outcome, pnl_trading + rebate_est - fees AS pnl FROM read_parquet(${p("markets.parquet")}) WHERE market_id = ${mid} AND mode = ${mode}`))[0] ?? null;
      return json(res, 200, { meta, fv, quotes, fills });
    }
  }
  if (parts[0] === "meta") return json(res, 200, { timeZone: cfg.dashboard.timeZone });
  if (parts[0] === "live" && parts[1] === "status") {
    const f = join(cfg.live.outDir, "status.json");
    if (!existsSync(f)) return json(res, 200, null);
    const s = JSON.parse(readFileSync(f, "utf8")) as { updatedAt: string };
    // a status older than 60 s means the live runner is not running
    return json(res, 200, { ...s, stale: Date.now() - Date.parse(s.updatedAt) > 60_000 });
  }
  if (parts[0] === "sweeps") {
    const root = join(dataDir, "sweeps");
    const ids = existsSync(root) ? readdirSync(root).filter((d) => existsSync(join(root, d, "sweep.json"))) : [];
    const read = (id: string) => ({
      sweep: JSON.parse(readFileSync(join(root, id, "sweep.json"), "utf8")) as { createdAt: string },
      report: existsSync(join(root, id, "report.json")) ? JSON.parse(readFileSync(join(root, id, "report.json"), "utf8")) : null,
    });
    if (parts[1] === "latest") {
      const latest = ids.map((id) => ({ id, ...read(id) })).sort((a, b) => b.sweep.createdAt.localeCompare(a.sweep.createdAt))[0];
      return json(res, 200, latest ?? null);
    }
    if (parts[1] && safeId(parts[1]) && ids.includes(parts[1])) return json(res, 200, { id: parts[1], ...read(parts[1]) });
    return json(res, 200, ids);
  }
  if (parts[0] === "calibration") {
    const f = join(dataDir, "analysis", "fv_samples.parquet");
    if (!existsSync(f)) return json(res, 200, { bins: [], markets: 0, note: "run pnpm fv:calibrate" });
    const bins = await rows(`
      SELECT CASE WHEN secs_left > 600 THEN 'τ > 10 min' WHEN secs_left > 300 THEN '5–10 min' ELSE '< 5 min' END AS panel,
             least(9, floor(fv * 10))::INTEGER AS bucket,
             avg(fv) AS predicted, avg(outcome) AS actual, count(*) AS n, 'fv' AS source
      FROM read_parquet(${sqlStr(f)}) WHERE outcome IS NOT NULL GROUP BY ALL
      UNION ALL
      SELECT CASE WHEN secs_left > 600 THEN 'τ > 10 min' WHEN secs_left > 300 THEN '5–10 min' ELSE '< 5 min' END,
             least(9, floor(mid * 10))::INTEGER, avg(mid), avg(outcome), count(*), 'mid'
      FROM read_parquet(${sqlStr(f)}) WHERE outcome IS NOT NULL AND mid IS NOT NULL GROUP BY ALL
      ORDER BY 1, 6, 2`);
    const [m] = await rows(`SELECT count(DISTINCT market_id) AS markets FROM read_parquet(${sqlStr(f)}) WHERE outcome IS NOT NULL`);
    return json(res, 200, { bins, markets: Number(m?.markets ?? 0) });
  }
  json(res, 404, { error: "not found" });
}

const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    handle(url, res).catch((e: Error) => json(res, 500, { error: e.message }));
    return;
  }
  // static UI (after `pnpm --filter harness-dashboard build`)
  const path = normalize(join(dist, url.pathname === "/" ? "index.html" : url.pathname));
  const file = path.startsWith(dist) && existsSync(path) && statSync(path).isFile() ? path : join(dist, "index.html");
  if (!existsSync(file)) {
    res.writeHead(404);
    res.end("UI not built: pnpm --filter harness-dashboard build (or use pnpm dashboard for dev)");
    return;
  }
  res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}).listen(port, "127.0.0.1", () => console.log(`dashboard on http://127.0.0.1:${port}`));
