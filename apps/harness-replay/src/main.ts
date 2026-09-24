import { loadConfig } from "@rain/pm-harness-core";

const cfg = loadConfig(process.argv[2] ?? "config/default.yaml");
console.log(`harness-replay: config ok (${cfg.market.slugPrefix}). Replay CLI lands in Phase 6.`);
