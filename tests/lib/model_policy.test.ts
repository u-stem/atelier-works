import { describe, expect, test } from "bun:test";
import { modelFor } from "../../f/factory/lib/model_policy.ts";

const CONFIG = { model: "light-model", heavy_model: "heavy-model" };

describe("modelFor", () => {
  test("uses heavy_model for requirements on the first attempt", () => {
    expect(modelFor(CONFIG, "requirements", 1)).toBe("heavy-model");
  });

  test("uses heavy_model for pr_review on the first attempt", () => {
    expect(modelFor(CONFIG, "pr_review", 1)).toBe("heavy-model");
  });

  test("uses heavy_model for audit on the first attempt", () => {
    expect(modelFor(CONFIG, "audit", 1)).toBe("heavy-model");
  });

  test("uses model for implement on the first attempt", () => {
    expect(modelFor(CONFIG, "implement", 1)).toBe("light-model");
  });

  test("uses model for pr_fix on the first round", () => {
    expect(modelFor(CONFIG, "pr_fix", 1)).toBe("light-model");
  });

  test("escalates implement to heavy_model from the second attempt", () => {
    expect(modelFor(CONFIG, "implement", 2)).toBe("heavy-model");
  });

  test("keeps implement on heavy_model for later attempts", () => {
    expect(modelFor(CONFIG, "implement", 3)).toBe("heavy-model");
  });

  test("escalates pr_fix to heavy_model from the second round", () => {
    expect(modelFor(CONFIG, "pr_fix", 2)).toBe("heavy-model");
  });

  test("keeps requirements on heavy_model for later attempts", () => {
    expect(modelFor(CONFIG, "requirements", 3)).toBe("heavy-model");
  });
});
