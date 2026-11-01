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

  test("says that the way of proceeding is not accepted now", () => {
    expect(describeIntakeRefusal("profile_not_allowed")).toContain(
      "この進め方はいま受け付けていません",
    );
  });

  test("says that the approval-free profiles wait for the operator to enable the implementation", () => {
    expect(describeIntakeRefusal("implement_disabled")).toContain(
      "運用者が実装を有効にするまで、承認を省く進め方は使えません",
    );
  });

  test("says that the implementation is stopped", () => {
    expect(describeIntakeRefusal("implement_disabled")).toContain(
      "実装が止められています",
    );
  });

  test("names the fields of the bugfix for the characters that cannot be used", () => {
    expect(describeIntakeRefusal("invalid_body_chars")).toContain(
      "目的、受入基準、不具合の欄に使えない文字があります",
    );
  });

  test("names the fields of the bugfix for the body that is too long", () => {
    expect(describeIntakeRefusal("body_too_long")).toContain(
      "目的、受入基準、不具合の欄が長すぎます",
    );
  });

  test("says that the limit applies to the body after it was put together", () => {
    expect(describeIntakeRefusal("body_too_long")).toContain(
      "組み立てた後のIssueの本文は、65,536字までにしてください",
    );
  });

  test("says that the intake key is not in the expected form", () => {
    expect(describeIntakeRefusal("invalid_intake_key")).toContain("再送");
  });

  test("names the title limit", () => {
    expect(describeIntakeRefusal("title_too_long")).toContain("256");
  });

  test("names the body limit", () => {
    expect(describeIntakeRefusal("body_too_long")).toContain("65,536");
  });
});
