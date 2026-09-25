import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compactAll, parquetPath } from "./compact.ts";
import { computeDayHealth } from "./day.ts";
import { marketEvents, testConfig, W0, writeRaw } from "./fixtures.ts";
import { openStore, writeHealth, type Store } from "./store.ts";

const dir = mkdtempSync(join(tmpdir(), "raintrade-store-"));
const inst = await DuckDBInstance.create(":memory:");
const conn = await inst.connect();
const WS = W0 - 1_800_000; // 20:45–21:00: spans the 20h and 21h files
const evs = marketEvents({ windowStart: WS });
let store: Store;

beforeAll(async () => {
  // closed hours as .gz; one truncated line (crash) at the end of each file
  writeRaw(dir, evs, { extraLines: ['{"kind":"spot","exch'] });
  // the current hour, still plain text, must not be compacted
  writeRaw(dir, [{ ...evs[0]!, recvTs: BigInt(W0 + 7_200_000) * 1_000_000n }], { gzip: false });
  await compactAll(conn, dir);
  await writeHealth(conn, dir, "2026-09-24", (await computeDayHealth(testConfig(dir), "2026-09-24", W0 + 3_600_000)).markets);
  store = await openStore(dir);
});

afterAll(() => {
  store.close();
  conn.closeSync();
  inst.closeSync();
});

const q = async (sql: string) => (await store.conn.runAndReadAll(sql)).getRowObjectsJS() as Record<string, unknown>[];

describe("compaction + views", () => {
  it("writes one parquet file per table per closed hour and skips the open hour", () => {
    expect(existsSync(parquetPath(dir, "book_deltas", "2026-09-24", 21))).toBe(true);
    expect(existsSync(parquetPath(dir, "book_deltas", "2026-09-24", 20))).toBe(true);
    expect(existsSync(parquetPath(dir, "resolutions", "2026-09-24", 20))).toBe(false);
    expect(existsSync(parquetPath(dir, "resolutions", "2026-09-24", 21))).toBe(true);
    expect(existsSync(parquetPath(dir, "market_opens", "2026-09-24", 23))).toBe(false);
    expect(readdirSync(join(dir, "parquet", "_done", "2026-09-24")).sort()).toEqual(["20.json", "21.json"]);
  });

  it("preserves every event with its values", async () => {
    const count = (k: string) => BigInt(evs.filter((e) => e.kind === k).length);
    const [r] = await q(`SELECT
      (SELECT count(*) FROM book_deltas) AS deltas, (SELECT count(*) FROM spot) AS spot,
      (SELECT count(*) FROM res_prices) AS ticks, (SELECT count(*) FROM market_opens) AS opens,
      (SELECT count(*) FROM resolutions) AS res`);
    expect(r).toEqual({ deltas: count("book_delta"), spot: count("spot"), ticks: count("res_price"), opens: 1n, res: 1n });
    const [t] = await q("SELECT price, scaled, backfill, date FROM res_prices ORDER BY recv_ts LIMIT 1");
    expect(t).toMatchObject({ price: 84_000, scaled: "84000000000000000000000", backfill: false });
  });

  it("keeps recorded order via (recv_ts, date, hour, line)", async () => {
    const rows = await q(`SELECT recv_ts, hour, line FROM book_deltas ORDER BY recv_ts, date, hour, line`);
    const sorted = [...rows].sort((a, b) => (a.recv_ts as bigint) < (b.recv_ts as bigint) ? -1 : 1);
    expect(rows).toEqual(sorted);
    expect(new Set(rows.map((r) => `${r.hour}:${r.line}`)).size).toBe(rows.length);
  });

  it("joins metadata, official outcome and health in the markets view", async () => {
    const [m] = await q("SELECT slug, outcome, flags, excluded, cl_ticks FROM markets");
    expect(m).toEqual({ slug: `btc-updown-15m-${WS / 1000}`, outcome: "UP", flags: "", excluded: false, cl_ticks: 900 });
  });

  it("is idempotent: a second run does nothing, --force rewrites the same data", async () => {
    expect(await compactAll(conn, dir)).toEqual([]);
    const again = await compactAll(conn, dir, { force: true });
    expect(again.map((r) => r.hour).sort()).toEqual([20, 21]);
    expect(again.every((r) => r.badLines === 1)).toBe(true);
    const fresh = await openStore(dir);
    const [r] = (await fresh.conn.runAndReadAll("SELECT count(*) AS n FROM book_deltas")).getRowObjectsJS();
    expect(r!.n).toBe(BigInt(evs.filter((e) => e.kind === "book_delta").length));
    fresh.close();
  });

  it("opens with empty typed views when nothing is compacted yet", async () => {
    const empty = await openStore(mkdtempSync(join(tmpdir(), "raintrade-empty-")));
    const [r] = (await empty.conn.runAndReadAll("SELECT count(*) AS n FROM markets")).getRowObjectsJS();
    expect(r!.n).toBe(0n);
    empty.close();
  });
});
