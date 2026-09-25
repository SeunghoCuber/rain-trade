import { Rng } from "@rain/pm-harness-core";

export const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
export const mean = (xs: readonly number[]) => (xs.length ? sum(xs) / xs.length : NaN);

export function quantile(xs: readonly number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

export const median = (xs: readonly number[]) => quantile(xs, 0.5);

export function sd(xs: readonly number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
}

export function skew(xs: readonly number[]): number {
  if (xs.length < 3) return NaN;
  const m = mean(xs);
  const s = sd(xs);
  if (!s) return NaN;
  const n = xs.length;
  return (n / ((n - 1) * (n - 2))) * sum(xs.map((x) => ((x - m) / s) ** 3));
}

/** t-statistic of the mean against 0. */
export function tStat(xs: readonly number[]): number {
  const s = sd(xs);
  return xs.length > 1 && s > 0 ? mean(xs) / (s / Math.sqrt(xs.length)) : NaN;
}

export interface BootstrapResult {
  /** statistic on the original sample */
  estimate: number;
  lo95: number;
  hi95: number;
  /** share of resamples with statistic > 0 */
  pPositive: number;
  draws: number;
  blocks: number;
  /** a thinned sample of resampled statistics (for the V11 histogram) */
  sample: number[];
}

/**
 * Block bootstrap (PLAN.md §7.4): resample whole blocks (e.g. UTC days) with replacement, so
 * within-block autocorrelation and regimes are preserved. `stat` maps the pooled items to a number.
 */
export function blockBootstrap<T>(blocks: readonly (readonly T[])[], stat: (items: T[]) => number, draws = 10_000, seed = 42): BootstrapResult {
  const nonEmpty = blocks.filter((b) => b.length);
  const all = nonEmpty.flat();
  const estimate = stat(all);
  if (nonEmpty.length === 0) return { estimate, lo95: NaN, hi95: NaN, pPositive: NaN, draws: 0, blocks: 0, sample: [] };
  const rng = new Rng(seed);
  const stats: number[] = [];
  for (let d = 0; d < draws; d++) {
    const items: T[] = [];
    for (let b = 0; b < nonEmpty.length; b++) items.push(...nonEmpty[rng.int(0, nonEmpty.length)]!);
    const v = stat(items);
    if (Number.isFinite(v)) stats.push(v);
  }
  const step = Math.max(1, Math.floor(stats.length / 1000));
  return {
    estimate,
    lo95: quantile(stats, 0.025),
    hi95: quantile(stats, 0.975),
    pPositive: stats.filter((x) => x > 0).length / Math.max(1, stats.length),
    draws: stats.length,
    blocks: nonEmpty.length,
    sample: stats.filter((_, i) => i % step === 0),
  };
}

/** Drawdown path of a cumulative series: peak-to-trough in value and in steps, and steps to recover. */
export function drawdown(cum: readonly number[]): { maxDd: number; maxDdSteps: number; recoverSteps: number | null; underwater: number[] } {
  let peak = 0, peakIdx = -1, maxDd = 0, maxDdSteps = 0, troughIdx = -1, ddPeakIdx = -1;
  const underwater: number[] = [];
  cum.forEach((v, i) => {
    if (v > peak) {
      peak = v;
      peakIdx = i;
    }
    const dd = v - peak;
    underwater.push(dd);
    if (dd < maxDd) {
      maxDd = dd;
      troughIdx = i;
      ddPeakIdx = peakIdx;
      maxDdSteps = i - peakIdx;
    }
  });
  let recoverSteps: number | null = null;
  if (troughIdx >= 0) {
    const peakValue = ddPeakIdx >= 0 ? cum[ddPeakIdx]! : 0;
    for (let i = troughIdx + 1; i < cum.length; i++) {
      if (cum[i]! >= peakValue) {
        recoverSteps = i - troughIdx;
        break;
      }
    }
  }
  return { maxDd, maxDdSteps, recoverSteps, underwater };
}
