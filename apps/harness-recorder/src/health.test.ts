import { describe, expect, it } from "vitest";
import { Health } from "./health.ts";

describe("Health", () => {
  it("does not report a feed registered long after start as silent before it had a chance to connect", () => {
    let now = 0;
    const alerts: string[] = [];
    const h = new Health(() => now, (t) => alerts.push(t), () => 30_000);
    now = 3_600_000; // an hour into the run, a new market's feed is registered…
    h.feed("clob:new");
    h.check(); // …and the periodic check lands a few ms later
    expect(alerts).toEqual([]);
    now += 31_000; // still nothing after the silence limit: that one is real
    h.check();
    expect(alerts).toEqual(["🚨 clob:new silent for 31s (disconnected)"]);
    h.onEvents("clob:new", 1);
    expect(alerts.at(-1)).toBe("✅ clob:new recovered");
  });
});
