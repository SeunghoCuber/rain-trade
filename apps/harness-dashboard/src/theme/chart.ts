// Chart colors for the dark trading dashboard (DESIGN.md surfaces). Categorical slots are the
// validated dataviz reference steps for dark mode, checked against our card surface #1e2329:
//   modes (3, all-pairs) and PnL components (4, adjacent) pass every validator gate.
import type { Mode } from "../api.ts";

export const C = {
  surface: "#1e2329",
  grid: "#2b3139",
  axis: "#707a8a",
  ink: "#eaecef",
  inkStrong: "#ffffff",
  muted: "#929aa5",
  up: "#0ecb81",
  down: "#f6465d",
  slot: ["#3987e5", "#d95926", "#199e70", "#c98500"] as [string, string, string, string],
  divNeg: "#e66767",
  divPos: "#3987e5",
  divMid: "#383835",
};

export const MODE_COLOR: Record<Mode, string> = { optimistic: C.slot[0]!, base: C.slot[1]!, pessimistic: C.slot[2]! };

export const axisProps = { stroke: C.grid, tick: { fill: C.axis, fontSize: 11 }, tickLine: false } as const;
export const gridProps = { stroke: C.grid, strokeDasharray: "0", vertical: false } as const;
export const tooltipProps = {
  contentStyle: { background: C.surface, border: `1px solid ${C.grid}`, borderRadius: 8, color: C.ink, fontSize: 12 },
  labelStyle: { color: C.muted },
  itemStyle: { color: C.ink },
  cursor: { stroke: C.axis, strokeWidth: 1 },
} as const;

// Display time zone: set once from /api/meta (config dashboard.timeZone), Pacific by default.
let timeZone = "America/Los_Angeles";
const parts = (ms: number, o: Intl.DateTimeFormatOptions) =>
  Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", ...o }).formatToParts(ms).map((p) => [p.type, p.value]));
export function setTimeZone(tz: string): void {
  timeZone = tz;
}
/** Zone abbreviation at `ms` (PDT / PST …). */
export function tzName(ms: number = Date.now()): string {
  return parts(ms, { timeZoneName: "short" }).timeZoneName ?? timeZone;
}

export const fmt = {
  usd: (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? "—" : `${x < 0 ? "−" : ""}$${Math.abs(x).toFixed(d)}`),
  num: (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? "—" : x.toFixed(d).replace("-", "−")),
  cents: (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? "—" : `${x.toFixed(d).replace("-", "−")}¢`),
  pct: (x: number | null | undefined, d = 0) => (x == null || !Number.isFinite(x) ? "—" : `${x.toFixed(d)}%`),
  time: (ms: number) => {
    const p = parts(ms, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    return `${p.month}-${p.day} ${p.hour}:${p.minute}`;
  },
  clock: (ms: number) => {
    const p = parts(ms, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    return `${p.hour}:${p.minute}:${p.second}`;
  },
};

/** Diverging fill: blue (positive) ↔ gray ↔ red (negative), by |v| / max. */
export function diverging(v: number | null, max: number): string {
  if (v === null || !Number.isFinite(v) || max <= 0) return "transparent";
  const t = Math.min(1, Math.abs(v) / max);
  const mix = (a: string, b: string) => {
    const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
    const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
    return `rgb(${pa.map((x, i) => Math.round(x + (pb[i]! - x) * t)).join(",")})`;
  };
  return mix(C.divMid, v >= 0 ? C.divPos : C.divNeg);
}
