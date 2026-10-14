import { describe, expect, test } from "bun:test";
import { contrastRatio, mixLinear, oklchToLinearRgb } from "./contrast.ts";

describe("contrastRatio", () => {
  test("is 21 between black and white", () => {
    expect(
      Math.round(
        contrastRatio(oklchToLinearRgb("0 0 0"), oklchToLinearRgb("1 0 0")),
      ),
    ).toBe(21);
  });

  test("is 1 for the same color", () => {
    expect(
      contrastRatio(
        oklchToLinearRgb("0.5 0.1 200"),
        oklchToLinearRgb("0.5 0.1 200"),
      ),
    ).toBe(1);
  });

  test("does not depend on the order", () => {
    const a = oklchToLinearRgb("0.3 0.05 100");
    const b = oklchToLinearRgb("0.9 0.02 100");
    expect(contrastRatio(a, b)).toBe(contrastRatio(b, a));
  });
});

describe("mixLinear", () => {
  test("returns the base for alpha 0", () => {
    expect(mixLinear([0.2, 0.4, 0.6], [1, 1, 1], 0)).toEqual([0.2, 0.4, 0.6]);
  });

  test("returns the tint for alpha 1", () => {
    expect(mixLinear([0.2, 0.4, 0.6], [1, 0, 0], 1)).toEqual([1, 0, 0]);
  });
});
