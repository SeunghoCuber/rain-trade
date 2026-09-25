import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { hourFile, HourlyNdjsonWriter } from "./writer.ts";

const H = Date.parse("2026-09-24T21:00:00Z");

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "raintrade-writer-"));
  let now = H + 1000;
  const errors: Error[] = [];
  const w = new HourlyNdjsonWriter(dir, () => now, (e) => errors.push(e));
  return { dir, w, errors, setNow: (t: number) => (now = t) };
}

describe("HourlyNdjsonWriter", () => {
  it("names files by UTC hour", () => {
    expect(hourFile("d", H + 59 * 60_000)).toBe(join("d", "raw", "2026-09-24", "21.ndjson"));
    expect(hourFile("d", H + 3 * 3600_000)).toBe(join("d", "raw", "2026-09-25", "00.ndjson"));
  });

  it("rotates at the hour, gzips the closed hour, and keeps the current one plain", async () => {
    const s = setup();
    s.w.write('{"a":1}');
    s.w.write('{"a":2}');
    s.setNow(H + 3600_000 + 5);
    s.w.write('{"a":3}');
    await s.w.close();
    const day = join(s.dir, "raw", "2026-09-24");
    expect(readdirSync(day).sort()).toEqual(["21.ndjson.gz", "22.ndjson"]);
    expect(gunzipSync(readFileSync(join(day, "21.ndjson.gz"))).toString()).toBe('{"a":1}\n{"a":2}\n');
    expect(readFileSync(join(day, "22.ndjson"), "utf8")).toBe('{"a":3}\n');
    expect(s.errors).toEqual([]);
  });

  it("appends to the current hour after a restart", async () => {
    const s = setup();
    s.w.write("1");
    await s.w.close();
    const w2 = new HourlyNdjsonWriter(s.dir, () => H + 2000, () => {});
    w2.write("2");
    await w2.close();
    expect(readFileSync(hourFile(s.dir, H), "utf8")).toBe("1\n2\n");
  });

  it("recovers leftovers from a crash: compresses old plain hours, drops partial .gz.tmp", async () => {
    const s = setup();
    const day = join(s.dir, "raw", "2026-09-24");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, "19.ndjson"), "old\n");
    writeFileSync(join(day, "20.ndjson"), "older-crash\n");
    writeFileSync(join(day, "20.ndjson.gz.tmp"), "garbage");
    writeFileSync(join(day, "21.ndjson"), "current\n"); // current hour: must stay appendable
    s.w.recoverLeftovers();
    await s.w.close();
    expect(readdirSync(day).sort()).toEqual(["19.ndjson.gz", "20.ndjson.gz", "21.ndjson"]);
    expect(gunzipSync(readFileSync(join(day, "20.ndjson.gz"))).toString()).toBe("older-crash\n");
    expect(existsSync(join(day, "20.ndjson.gz.tmp"))).toBe(false);
  });
});
