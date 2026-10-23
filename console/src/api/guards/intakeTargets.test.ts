import { describe, expect, test } from "bun:test";
import { isIntakeTargets } from "./intakeTargets.ts";

describe("isIntakeTargets", () => {
  test("accepts an empty list", () => {
    expect(isIntakeTargets([])).toBe(true);
  });

  test("accepts entries with an owner and a repo", () => {
    expect(
      isIntakeTargets([
        { owner: "octo-owner", repo: "atelier-works" },
        { owner: "octo-owner", repo: "widgets" },
      ]),
    ).toBe(true);
  });

  test("rejects an entry without a repo", () => {
    expect(isIntakeTargets([{ owner: "octo-owner" }])).toBe(false);
  });

  test("rejects an entry whose owner is not a string", () => {
    expect(isIntakeTargets([{ owner: 1, repo: "widgets" }])).toBe(false);
  });

  test("rejects a single object", () => {
    expect(isIntakeTargets({ owner: "octo-owner", repo: "widgets" })).toBe(
      false,
    );
  });

  test("rejects null", () => {
    expect(isIntakeTargets(null)).toBe(false);
  });
});
