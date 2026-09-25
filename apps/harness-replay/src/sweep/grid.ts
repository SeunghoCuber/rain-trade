import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { Config, loadConfig, type FillMode } from "@rain/pm-harness-core";

export type Value = number | string | boolean;

export interface Grid {
  base: Config;
  params: [string, Value[]][];
  plateauAxes: string[];
  mode: FillMode;
  minInSampleVolume: number;
}

export interface GridPoint {
  id: string;
  overrides: Record<string, Value>;
  cfg: Config;
}

export function loadGrid(path: string): Grid {
  const raw = parse(readFileSync(path, "utf8")) as { base?: string; params: Record<string, Value[]>; plateauAxes?: string[]; mode?: FillMode; minInSampleVolume?: number };
  const params = Object.entries(raw.params);
  const plateauAxes = raw.plateauAxes ?? params.slice(0, 2).map(([k]) => k);
  for (const a of plateauAxes) if (!raw.params[a]) throw new Error(`plateau axis ${a} is not a swept param`);
  return { base: loadConfig(raw.base ?? "config/default.yaml"), params, plateauAxes, mode: raw.mode ?? "pessimistic", minInSampleVolume: raw.minInSampleVolume ?? 0 };
}

/** Deep-copy `cfg` with `path` (dotted) set to `value`, re-validated. */
export function withOverride(cfg: Config, path: string, value: Value): Config {
  const copy = structuredClone(cfg) as Record<string, unknown>;
  const keys = path.split(".");
  let o = copy;
  for (const k of keys.slice(0, -1)) {
    if (typeof o[k] !== "object" || o[k] === null) throw new Error(`bad config path ${path}`);
    o = o[k] as Record<string, unknown>;
  }
  if (!(keys.at(-1)! in o)) throw new Error(`unknown config key ${path}`);
  o[keys.at(-1)!] = value;
  return Config.parse(copy);
}

/** Cartesian product of the grid, in a stable order. */
export function expand(g: Grid): GridPoint[] {
  let points: Record<string, Value>[] = [{}];
  for (const [path, values] of g.params) points = points.flatMap((p) => values.map((v) => ({ ...p, [path]: v })));
  return points.map((overrides, i) => {
    let cfg = g.base;
    for (const [p, v] of Object.entries(overrides)) cfg = withOverride(cfg, p, v);
    return { id: `c${String(i).padStart(3, "0")}`, overrides, cfg };
  });
}
