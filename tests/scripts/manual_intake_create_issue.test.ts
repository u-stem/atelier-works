import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildManualIntakeIssueBody } from "../../f/factory/steps/manual_intake_create_issue.ts";

// `isRepoAllowed`は`f/factory/lib/config.ts`にあり、
// テストは`tests/lib/config.test.ts`にある。

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

describe("the entry point of the issue creation", () => {
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
    readFileSync(
      join(
        import.meta.dir,
        "../../f/factory/steps/manual_intake_create_issue.ts",
      ),
      "utf8",
    ),
  );

  test("takes the profile and defaults it to standard", () => {
    expect(code).toMatch(/\bprofile = "standard"/);
  });

  test("refuses a profile that is not accepted before it creates the issue", () => {
    expect(code.slice(0, code.indexOf("await createIssue("))).toContain(
      "assertAcceptedProfile(profile)",
    );
  });

  test("refuses a profile that is not accepted before it reads the token", () => {
    expect(code.slice(0, code.indexOf("github_token"))).toContain(
      "assertAcceptedProfile(profile)",
    );
  });
});
