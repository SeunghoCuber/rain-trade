// Sweep worker: one replay pass over the recorded data, feeding one BacktestRunner per config.
import { parentPort, workerData } from "node:worker_threads";
import { DuckDBInstance } from "@duckdb/node-api";
import { ReplayClock, runReplay, type Config, type FillMode } from "@rain/pm-harness-core";
import { replay, type ReplayOptions } from "@rain/pm-harness-store";
import { BacktestRunner, MarketMaker, type MarketResultRow } from "@rain/pm-harness-strategy";

export interface WorkerInput {
  dataDir: string;
  replay: ReplayOptions;
  modes: FillMode[];
  configs: { id: string; cfg: Config }[];
}

export interface WorkerOutput {
  results: { id: string; rows: MarketResultRow[] }[];
  events: number;
}

const input = workerData as WorkerInput;
const inst = await DuckDBInstance.create(":memory:");
const conn = await inst.connect();
const clock = new ReplayClock();
const runners = input.configs.map((c) => ({ id: c.id, r: new BacktestRunner({ cfg: c.cfg, clock, modes: input.modes, strategy: () => new MarketMaker(c.cfg) }) }));
let events = 0;
await runReplay(replay(conn, input.dataDir, { rawOnly: true, ...input.replay }), clock, (ev) => {
  events++;
  for (const x of runners) x.r.handle(ev);
});
conn.closeSync();
inst.closeSync();
parentPort!.postMessage({ results: runners.map((x) => ({ id: x.id, rows: x.r.results })), events } satisfies WorkerOutput);
