import { describe, expect, it } from "vitest";
import { bootstrapCI, choose, confusionMatrix, fisherOneSided, passAtK, passHatK, weightedKappa } from "../flywheel/metrics/stats";

describe("pass@k / pass^k", () => {
  it("matches hand-computed values for n=5, c=2", () => {
    expect(passAtK(5, 2, 1)).toBeCloseTo(0.4);
    expect(passAtK(5, 2, 2)).toBeCloseTo(1 - 3 / 10); // 1 - C(3,2)/C(5,2)
    expect(passAtK(5, 2, 4)).toBe(1); // only 3 failures: any 4 draws include a pass
    expect(passHatK(5, 2, 1)).toBeCloseTo(0.4);
    expect(passHatK(5, 2, 2)).toBeCloseTo(1 / 10); // C(2,2)/C(5,2)
    expect(passHatK(5, 2, 3)).toBe(0);
  });
  it("handles all-fail and all-pass", () => {
    for (let k = 1; k <= 5; k++) {
      expect(passAtK(5, 0, k)).toBe(0);
      expect(passHatK(5, 0, k)).toBe(0);
      expect(passAtK(5, 5, k)).toBe(1);
      expect(passHatK(5, 5, k)).toBe(1);
    }
  });
  it("pass@k is non-decreasing and pass^k non-increasing in k", () => {
    for (let k = 1; k < 5; k++) {
      expect(passAtK(5, 3, k + 1)).toBeGreaterThanOrEqual(passAtK(5, 3, k));
      expect(passHatK(5, 3, k + 1)).toBeLessThanOrEqual(passHatK(5, 3, k));
    }
  });
  it("rejects k > n", () => {
    expect(() => passAtK(3, 1, 4)).toThrow();
  });
  it("choose", () => {
    expect(choose(5, 2)).toBe(10);
    expect(choose(8, 5)).toBe(56);
    expect(choose(3, 4)).toBe(0);
  });
});

describe("Fisher exact (one-sided)", () => {
  it("5/5 -> 0/3 has p = 1/C(8,5)", () => {
    expect(fisherOneSided(5, 5, 0, 3)).toBeCloseTo(1 / 56, 6);
  });
  it("3/3 -> 0/3 is exactly 0.05 (the most extreme result with k=3)", () => {
    expect(fisherOneSided(3, 3, 0, 3)).toBeCloseTo(0.05, 6);
  });
  it("no drop is not significant", () => {
    expect(fisherOneSided(2, 3, 2, 3)).toBeGreaterThan(0.5);
    expect(fisherOneSided(0, 3, 3, 3)).toBeCloseTo(1, 9);
  });
});

describe("weighted kappa", () => {
  it("equals Cohen's kappa for 2 categories ([[20,5],[10,15]] -> 0.4)", () => {
    const a = [...Array(20).fill(0), ...Array(5).fill(0), ...Array(10).fill(1), ...Array(15).fill(1)];
    const b = [...Array(20).fill(0), ...Array(5).fill(1), ...Array(10).fill(0), ...Array(15).fill(1)];
    expect(weightedKappa(a, b, 2)).toBeCloseTo(0.4, 6);
  });
  it("is 1 for perfect agreement", () => {
    expect(weightedKappa([0, 1, 2, 3], [0, 1, 2, 3], 4)).toBe(1);
  });
  it("matches an independently computed quadratic-weighted value", () => {
    const a = [0, 0, 1, 1, 2, 2, 3, 3, 3, 1];
    const b = [0, 1, 1, 2, 2, 2, 3, 2, 3, 0];
    expect(weightedKappa(a, b, 4)).toBeCloseTo(47 / 57, 6);
  });
  it("penalizes far disagreements more than near ones", () => {
    const human = [0, 1, 2, 3, 0, 1, 2, 3];
    const near = [1, 1, 2, 2, 0, 2, 2, 3];
    const far = [3, 1, 2, 0, 0, 1, 0, 3];
    expect(weightedKappa(human, near, 4)).toBeGreaterThan(weightedKappa(human, far, 4));
  });
  it("confusion matrix counts", () => {
    expect(confusionMatrix([0, 1, 1], [0, 0, 1], 2)).toEqual([[1, 0], [1, 1]]);
  });
});

describe("bootstrap", () => {
  it("is deterministic and brackets the mean", () => {
    const xs = [0, 1, 1, 1, 0, 1, 1, 0, 1, 1];
    const mean = (s: number[]) => s.reduce((a, b) => a + b, 0) / s.length;
    const ci = bootstrapCI(xs, mean);
    expect(ci).toEqual(bootstrapCI(xs, mean));
    expect(ci[0]).toBeLessThanOrEqual(0.7);
    expect(ci[1]).toBeGreaterThanOrEqual(0.7);
  });
});
