// approval_decideが断るときの英語の文を、Console(console/)が日本語の固定文に直せることを確かめる。
// 文は別々に書かれているので、片方だけを変えたときにここで落とす。
// Windmillが失敗の結果を包む形(JSONの封筒と、Error:を前置きした文)も通す。

import { describe, expect, test } from "bun:test";
import { classifyRunResponse } from "../../console/src/api/errors.ts";
import { classifyDecisionRefusal } from "../../console/src/lib/approvalRefusal.ts";
import {
  assertValidApprovalDecideInput,
  missingApprovalRequestMessage,
  recordedDecisionRefusalMessage,
} from "../../f/factory/approval_decide.ts";
import { issueCheckRefusal } from "../../f/factory/lib/approval_support.ts";

function jobFailed(message: string) {
  return { kind: "job_failed" as const, message };
}

function reasonRequiredMessage(): string {
  try {
    assertValidApprovalDecideInput({ decision: "reject", reason: " " });
  } catch (error) {
    return error instanceof Error ? error.message : "";
  }
  return "";
}

/** Windmillがscriptの例外を返す形(JSONの`error.message`)。 */
function inEnvelope(message: string) {
  return classifyRunResponse(
    500,
    JSON.stringify({
      error: {
        name: "Error",
        message,
        stack: `Error: ${message}\n    at main (file:///tmp/script.ts:1:1)`,
      },
    }),
  );
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
    expect(
      classifyDecisionRefusal(jobFailed(reasonRequiredMessage()))?.kind,
    ).toBe("reason_required");
  });

  test("recognizes the refusal to overwrite a recorded decision", () => {
    expect(
      classifyDecisionRefusal(
        jobFailed(recordedDecisionRefusalMessage(3, "rejected", "approved")),
      )?.kind,
    ).toBe("conflict");
  });

  test("recognizes the refusal for a request that does not exist", () => {
    expect(
      classifyDecisionRefusal(jobFailed(missingApprovalRequestMessage(3)))
        ?.kind,
    ).toBe("missing");
  });

  test("recognizes a refusal inside the failure envelope of Windmill", () => {
    const result = inEnvelope(issueCheckRefusal("changed", 3) ?? "");
    expect(result.ok ? null : classifyDecisionRefusal(result.error)?.kind).toBe(
      "changed",
    );
  });

  test("recognizes a refusal in a plain text failure with Error: in front", () => {
    const result = classifyRunResponse(
      500,
      `Error: ${recordedDecisionRefusalMessage(3, "rejected", "approved")}`,
    );
    expect(result.ok ? null : classifyDecisionRefusal(result.error)?.kind).toBe(
      "conflict",
    );
  });

  test("does not mistake a failure of another script for a refusal", () => {
    const result = inEnvelope("retry_work_item: work item 3 was not found");
    expect(result.ok ? null : classifyDecisionRefusal(result.error)).toBeNull();
  });
});
