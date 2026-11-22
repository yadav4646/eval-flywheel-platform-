// Small, dependency-free statistics used across the flywheel. Everything here is
// pure and unit-tested in tests/stats.test.ts.

import { rng } from "../../db/seed";

/** n choose k as a float (fine for the small n we use). */
export function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/**
 * Unbiased pass@k estimator (Chen et al., 2021): probability that at least one of
 * k samples drawn without replacement from n trials (c correct) is correct.
 */
export function passAtK(n: number, c: number, k: number): number {
  if (k > n) throw new Error(`pass@k needs k <= n (k=${k}, n=${n})`);
  if (n - c < k) return 1;
  return 1 - choose(n - c, k) / choose(n, k);
}

/** pass^k: probability that ALL k samples drawn from the n trials are correct (reliability). */
export function passHatK(n: number, c: number, k: number): number {
  if (k > n) throw new Error(`pass^k needs k <= n (k=${k}, n=${n})`);
  return choose(c, k) / choose(n, k);
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

export function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Percentile bootstrap CI of a statistic over items (resampling items, seeded). */
export function bootstrapCI<T>(items: T[], stat: (sample: T[]) => number, { iters = 1000, alpha = 0.05, seed = 7 } = {}): [number, number] {
  if (items.length === 0) return [NaN, NaN];
  const r = rng(seed);
  const vals: number[] = [];
  for (let i = 0; i < iters; i++) {
    const sample = Array.from({ length: items.length }, () => items[Math.floor(r() * items.length)]);
    const v = stat(sample);
    if (Number.isFinite(v)) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  const lo = vals[Math.floor((alpha / 2) * vals.length)];
  const hi = vals[Math.min(vals.length - 1, Math.ceil((1 - alpha / 2) * vals.length) - 1)];
  return [lo, hi];
}

function logFactorial(n: number): number {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
}

/**
 * One-sided Fisher exact test: is the base pass rate (cBase/nBase) significantly
 * HIGHER than head (cHead/nHead)? Returns p = P(X >= cBase) under the hypergeometric null.
 */
export function fisherOneSided(cBase: number, nBase: number, cHead: number, nHead: number): number {
  const K = cBase + cHead; // total passes
  const N = nBase + nHead;
  const lf = (x: number) => logFactorial(x);
  const logDenom = lf(N) - lf(nBase) - lf(N - nBase);
  let p = 0;
  for (let x = cBase; x <= Math.min(K, nBase); x++) {
    const logP = lf(K) - lf(x) - lf(K - x) + (lf(N - K) - lf(nBase - x) - lf(N - K - (nBase - x))) - logDenom;
    p += Math.exp(logP);
  }
  return Math.min(1, p);
}

/**
 * Cohen's kappa with quadratic weights for ordinal labels 0..m-1.
 * Equals unweighted kappa when m = 2.
 */
export function weightedKappa(a: number[], b: number[], m: number): number {
  if (a.length !== b.length || a.length === 0) return NaN;
  const n = a.length;
  const O = Array.from({ length: m }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i++) O[a[i]][b[i]] += 1;
  const rowSum = O.map((r) => r.reduce((x, y) => x + y, 0));
  const colSum = O[0].map((_, j) => O.reduce((s, r) => s + r[j], 0));
  let num = 0;
  let den = 0;
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) {
      const w = m === 1 ? 0 : (i - j) ** 2 / (m - 1) ** 2;
      const E = (rowSum[i] * colSum[j]) / n;
      num += w * O[i][j];
      den += w * E;
    }
  }
  if (den === 0) return 1; // all mass on one category for both raters
  return 1 - num / den;
}

export function confusionMatrix(a: number[], b: number[], m: number): number[][] {
  const O = Array.from({ length: m }, () => new Array(m).fill(0));
  for (let i = 0; i < a.length; i++) O[a[i]][b[i]] += 1;
  return O;
}
