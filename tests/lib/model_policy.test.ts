import { describe, expect, test } from "bun:test";
import {
  modelChangesAfterFailure,
  modelFor,
  prFixRetryModel,
} from "../../f/factory/lib/model_policy.ts";

const CONFIG = { model: "light-model", heavy_model: "heavy-model" };

describe("modelFor", () => {
  test.each([
    "requirements",
    "design",
    "pr_review",
    "audit",
    "dependabot",
  ] as const)("uses heavy_model for %s with no failures", (stage) => {
    expect(modelFor(CONFIG, stage, 0)).toBe("heavy-model");
  });

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

describe("modelFor for dependabot", () => {
  test("keeps heavy_model after many failures", () => {
    expect(modelFor(CONFIG, "dependabot", 5)).toBe("heavy-model");
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

describe("modelChangesAfterFailure", () => {
  test("is false when the next failure keeps model", () => {
    expect(modelChangesAfterFailure(CONFIG, "implement", 0)).toBe(false);
  });

  test("is true when the next failure reaches the escalation count", () => {
    expect(modelChangesAfterFailure(CONFIG, "implement", 1)).toBe(true);
  });

  test("is false once heavy_model is already in use", () => {
    expect(modelChangesAfterFailure(CONFIG, "implement", 2)).toBe(false);
  });

  test("is false after the escalation count has passed", () => {
    expect(modelChangesAfterFailure(CONFIG, "implement", 3)).toBe(false);
  });

  test("is true for pr_fix at the same boundary", () => {
    expect(modelChangesAfterFailure(CONFIG, "pr_fix", 1)).toBe(true);
  });

  test("is false for a stage that always uses heavy_model", () => {
    expect(modelChangesAfterFailure(CONFIG, "pr_review", 1)).toBe(false);
  });

  test("is false for dependabot, which always uses heavy_model", () => {
    expect(modelChangesAfterFailure(CONFIG, "dependabot", 1)).toBe(false);
  });

  test("is false when model and heavy_model are the same", () => {
    expect(
      modelChangesAfterFailure(
        { model: "same-model", heavy_model: "same-model" },
        "implement",
        1,
      ),
    ).toBe(false);
  });
});
