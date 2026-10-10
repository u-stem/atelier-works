import { describe, expect, test } from "bun:test";
import { modelFor, prFixRetryModel } from "../../f/factory/lib/model_policy.ts";

const CONFIG = { model: "light-model", heavy_model: "heavy-model" };

describe("modelFor", () => {
  test.each(["requirements", "pr_review", "audit"] as const)(
    "uses heavy_model for %s with no failures",
    (stage) => {
      expect(modelFor(CONFIG, stage, 0)).toBe("heavy-model");
    },
  );

  test("uses model for implement with no failures", () => {
    expect(modelFor(CONFIG, "implement", 0)).toBe("light-model");
  });

  test("uses model for implement after one failure", () => {
    expect(modelFor(CONFIG, "implement", 1)).toBe("light-model");
  });

  test("uses heavy_model for implement after two failures", () => {
    expect(modelFor(CONFIG, "implement", 2)).toBe("heavy-model");
  });

  test("keeps heavy_model for implement after more failures", () => {
    expect(modelFor(CONFIG, "implement", 5)).toBe("heavy-model");
  });

  test("uses model for pr_fix with no failures", () => {
    expect(modelFor(CONFIG, "pr_fix", 0)).toBe("light-model");
  });

  test("uses model for pr_fix after one failure", () => {
    expect(modelFor(CONFIG, "pr_fix", 1)).toBe("light-model");
  });

  test("uses heavy_model for pr_fix after two failures", () => {
    expect(modelFor(CONFIG, "pr_fix", 2)).toBe("heavy-model");
  });
});

describe("prFixRetryModel", () => {
  test("uses model when the retry follows the first failure", () => {
    expect(prFixRetryModel(CONFIG, 0)).toBe("light-model");
  });

  test("uses heavy_model when one earlier failure is already recorded", () => {
    expect(prFixRetryModel(CONFIG, 1)).toBe("heavy-model");
  });
});
