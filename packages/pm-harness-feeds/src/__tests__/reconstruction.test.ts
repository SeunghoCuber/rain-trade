import { MarketStates } from "@rain/pm-harness-core";
import { describe, expect, it } from "vitest";
import type { GammaEvent } from "../gamma.ts";
import { normalizeClob } from "../normalize/clob.ts";
import { sampleFrames, sampleJson } from "./samples.ts";

// Regression guard for the book model (VERIFIED.md §3): the 75 s Phase 0 capture must rebuild
// exactly, with and without dropping the mirrored DOWN side.
describe("book reconstruction on the Phase 0 capture", () => {
  const ev = sampleJson<GammaEvent[]>("gamma-event-current.json")[0]!;
  const [UP, DOWN] = JSON.parse(ev.markets[0]!.clobTokenIds) as [string, string];
  const frames = sampleFrames("clob-ws-market.ndjson.gz");

  for (const dropMirrored of [false, true]) {
    it(`matches every snapshot and every reported best bid/ask (dropMirrored=${dropMirrored})`, () => {
      const st = new MarketStates({ verify: true });
      let i = 0;
      for (const f of frames) {
        for (const e of normalizeClob(f.data, { marketId: "m", upTokenId: UP, downTokenId: DOWN, dropMirrored }, BigInt(i++)).events) st.apply(e);
      }
      expect(st.checks).toMatchObject({ snapshotMismatches: 0, bestMismatches: 0, unsyncedChanges: 0 });
      expect(st.checks.bestChecked).toBe(dropMirrored ? 31_644 : 63_288);
      expect(st.checks.levelsPruned).toBe(6); // liquidity consumed by matches, never sent as level updates
    });
  }
});
