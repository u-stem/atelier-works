import { describe, expect, test } from "bun:test";
import { MANUAL_INTAKE_REFUSAL_REASONS } from "../api/guards/writeResults.ts";
import { describeIntakeRefusal } from "./intakeRefusal.ts";

describe("describeIntakeRefusal", () => {
  test.each([...MANUAL_INTAKE_REFUSAL_REASONS])(
    "explains %s in a sentence that ends with a full stop",
    (reason) => {
      expect(describeIntakeRefusal(reason).endsWith("。")).toBe(true);
    },
  );

  test.each([...MANUAL_INTAKE_REFUSAL_REASONS])(
    "does not show the raw code for %s",
    (reason) => {
      expect(describeIntakeRefusal(reason)).not.toContain(reason);
    },
  );

  test("gives each reason its own sentence", () => {
    expect(
      new Set(MANUAL_INTAKE_REFUSAL_REASONS.map(describeIntakeRefusal)).size,
    ).toBe(MANUAL_INTAKE_REFUSAL_REASONS.length);
  });

  test("says that nothing was submitted for a refusal", () => {
    expect(describeIntakeRefusal("repo_not_allowed")).toContain(
      "投入していません",
    );
  });

  test("names the title limit", () => {
    expect(describeIntakeRefusal("title_too_long")).toContain("256");
  });

  test("names the body limit", () => {
    expect(describeIntakeRefusal("body_too_long")).toContain("65,536");
  });
});
