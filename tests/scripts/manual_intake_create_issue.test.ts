import { describe, expect, test } from "bun:test";
import { buildManualIntakeIssueBody } from "../../f/factory/steps/manual_intake_create_issue.ts";

// isRepoAllowed moved to f/factory/lib/config.ts (promoted by the lib-core
// owner) and is covered there by tests/lib/config.test.ts.

describe("buildManualIntakeIssueBody", () => {
  test("renders the 目的 section from body", () => {
    const rendered = buildManualIntakeIssueBody({
      body: "Add a widget.",
      acceptance_criteria: "It renders.",
    });
    expect(rendered).toContain("### 目的\n\nAdd a widget.");
  });

  test("renders the 受入基準 section from acceptance_criteria", () => {
    const rendered = buildManualIntakeIssueBody({
      body: "Add a widget.",
      acceptance_criteria: "It renders.",
    });
    expect(rendered).toContain("### 受入基準\n\nIt renders.");
  });

  test("renders _No response_ for a blank acceptance_criteria", () => {
    const rendered = buildManualIntakeIssueBody({
      body: "Add a widget.",
      acceptance_criteria: "   ",
    });
    expect(rendered).toContain("### 受入基準\n\n_No response_");
  });

  test("renders _No response_ for a blank body", () => {
    const rendered = buildManualIntakeIssueBody({
      body: "",
      acceptance_criteria: "It renders.",
    });
    expect(rendered).toContain("### 目的\n\n_No response_");
  });
});
