import { loadConfig } from "@rain/pm-harness-core";

const cfg = loadConfig(process.argv[2] ?? "config/default.yaml");
console.log(`harness-live: config ok (${cfg.market.slugPrefix}). Live runner lands in Phase 11.`);
