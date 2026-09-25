// Recording health for one UTC day, printed (not saved): `node src/stats.ts [YYYY-MM-DD] [config]`.
// `pnpm data:health` computes the same thing and also writes it to data/health/ for analytics.

import { loadConfig } from "@rain/pm-harness-core";
import { computeDayHealth, formatDayHealth } from "@rain/pm-harness-store";

const day = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const cfg = loadConfig(process.argv[3] ?? "config/default.yaml");
console.log(formatDayHealth(await computeDayHealth(cfg, day), cfg.market.durationSec));
