// approval_decideが断るときの英語の文を、Console(console/)が日本語の固定文に直せることを確かめる。
// 文は別々に書かれているので、片方だけを変えたときにここで落とす。

import { describe, expect, test } from "bun:test";
import { classifyDecisionRefusal } from "../../console/src/lib/approvalRefusal.ts";
import { assertValidApprovalDecideInput } from "../../f/factory/approval_decide.ts";
import { issueCheckRefusal } from "../../f/factory/lib/approval_support.ts";

function jobFailed(message: string) {
  return { kind: "job_failed" as const, message };
}

describe("approval refusal contract between approval_decide and the console", () => {
  test("recognizes the refusal for an issue that changed after intake", () => {
    expect(
      classifyDecisionRefusal(jobFailed(issueCheckRefusal("changed", 3) ?? ""))
        ?.kind,
    ).toBe("changed");
  });

  test("recognizes the refusal for an issue that could not be compared", () => {
    expect(
      classifyDecisionRefusal(
        jobFailed(issueCheckRefusal("unavailable", 3) ?? ""),
      )?.kind,
    ).toBe("unavailable");
  });

  test("recognizes the refusal for a rejection without a reason", () => {
    let message = "";
    try {
      assertValidApprovalDecideInput({ decision: "reject", reason: " " });
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(classifyDecisionRefusal(jobFailed(message))?.kind).toBe(
      "reason_required",
    );
  });
});
