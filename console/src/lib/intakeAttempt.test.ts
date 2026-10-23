import { describe, expect, test } from "bun:test";
import type { ApiError } from "../api/errors.ts";
import type { WriteOutcome } from "../api/executeWrite.ts";
import type { ManualIntakeSubmitResult } from "../api/guards/writeResults.ts";
import {
  attemptFromOutcome,
  confirmResend,
  describeIntakeAttempt,
  type IntakeAttempt,
  isSubmitBlocked,
  keepsInput,
} from "./intakeAttempt.ts";

const JOB = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

type Outcome = WriteOutcome<ManualIntakeSubmitResult>;

function done(result: ManualIntakeSubmitResult): Outcome {
  return { kind: "done", result };
}

function failed(error: ApiError): Outcome {
  return { kind: "failed", error, message: "メッセージ" };
}

const STARTED = done({ refused: false, flow_job_id: JOB });
const REFUSED = done({ refused: true, reason: "repo_not_allowed" });

/** 投入されたかが分からない失敗。フローの起動の後にも起こりうる。 */
const UNKNOWN_FAILURES: readonly [string, ApiError][] = [
  ["job_failed", { kind: "job_failed", message: "boom" }],
  ["invalid_response", { kind: "invalid_response" }],
  ["a 500", { kind: "http", status: 500, detail: "" }],
  ["a 503", { kind: "http", status: 503, detail: "" }],
  ["network", { kind: "network" }],
  ["timeout_or_unknown", { kind: "timeout_or_unknown" }],
];

/** ジョブが動く前に断られた失敗。投入されていない。 */
const REJECTED_FAILURES: readonly [string, ApiError][] = [
  ["unauthorized", { kind: "unauthorized" }],
  ["forbidden", { kind: "forbidden" }],
  ["a 400", { kind: "http", status: 400, detail: "bad" }],
  ["a 404", { kind: "http", status: 404, detail: "" }],
];

describe("attemptFromOutcome", () => {
  test("keeps the job id of a started flow", () => {
    expect(attemptFromOutcome(STARTED)).toEqual({
      kind: "submitted",
      flowJobId: JOB,
    });
  });

  test("explains a refusal in Japanese", () => {
    const attempt = attemptFromOutcome(REFUSED);
    expect(attempt.kind === "refused" && attempt.message).toContain(
      "許可されていません",
    );
  });

  test.each(UNKNOWN_FAILURES)("treats %s as not knowing", (_name, error) => {
    expect(attemptFromOutcome(failed(error)).kind).toBe("unknown");
  });

  test.each(REJECTED_FAILURES)("treats %s as rejected", (_name, error) => {
    expect(attemptFromOutcome(failed(error)).kind).toBe("rejected");
  });

  test("starts an unknown attempt without the resend confirmed", () => {
    const attempt = attemptFromOutcome(
      failed({ kind: "job_failed", message: "boom" }),
    );
    expect(attempt.kind === "unknown" && attempt.resendConfirmed).toBe(false);
  });

  test("carries the failure sentence of the write", () => {
    const attempt = attemptFromOutcome(failed({ kind: "network" }));
    expect(attempt.kind === "unknown" && attempt.message).toBe("メッセージ");
  });
});

describe("the submit button", () => {
  const unknown = attemptFromOutcome(failed({ kind: "network" }));

  test("is blocked after a result that is not known", () => {
    expect(isSubmitBlocked(unknown)).toBe(true);
  });

  test("is open again once the user confirmed the resend", () => {
    expect(isSubmitBlocked(confirmResend(unknown))).toBe(false);
  });

  test.each([
    ["idle", { kind: "idle" }],
    ["refused", attemptFromOutcome(REFUSED)],
    ["rejected", attemptFromOutcome(failed({ kind: "forbidden" }))],
    ["submitted", attemptFromOutcome(STARTED)],
  ] satisfies [string, IntakeAttempt][])("is open for %s", (_name, attempt) => {
    expect(isSubmitBlocked(attempt)).toBe(false);
  });

  test("confirming does not change an attempt that is not unknown", () => {
    const refused = attemptFromOutcome(REFUSED);
    expect(confirmResend(refused)).toBe(refused);
  });
});

describe("the input", () => {
  test.each([
    ["refused", attemptFromOutcome(REFUSED)],
    ["rejected", attemptFromOutcome(failed({ kind: "forbidden" }))],
    ["unknown", attemptFromOutcome(failed({ kind: "network" }))],
    ["idle", { kind: "idle" }],
  ] satisfies [string, IntakeAttempt][])("stays after %s", (_name, attempt) => {
    expect(keepsInput(attempt)).toBe(true);
  });

  test("is cleared after a submission", () => {
    expect(keepsInput(attemptFromOutcome(STARTED))).toBe(false);
  });
});

describe("describeIntakeAttempt", () => {
  test("shows nothing before the first try", () => {
    expect(describeIntakeAttempt({ kind: "idle" })).toBeNull();
  });

  test("shows a success with the link to the job", () => {
    expect(describeIntakeAttempt(attemptFromOutcome(STARTED))?.flowJobId).toBe(
      JOB,
    );
  });

  test("tells where the work item will appear", () => {
    expect(
      describeIntakeAttempt(attemptFromOutcome(STARTED))?.lines.join("\n"),
    ).toContain("作業項目の一覧");
  });

  test("tells where to look when the work item does not appear", () => {
    expect(
      describeIntakeAttempt(attemptFromOutcome(STARTED))?.lines.join("\n"),
    ).toContain("作業項目に紐づかない失敗");
  });

  test("shows a success as a success", () => {
    expect(describeIntakeAttempt(attemptFromOutcome(STARTED))?.tone).toBe(
      "success",
    );
  });

  test("shows a refusal as an error", () => {
    expect(describeIntakeAttempt(attemptFromOutcome(REFUSED))?.tone).toBe(
      "error",
    );
  });

  test("shows not knowing as a warning", () => {
    expect(
      describeIntakeAttempt(attemptFromOutcome(failed({ kind: "network" })))
        ?.tone,
    ).toBe("warning");
  });

  test("tells to check the Windmill jobs before sending again", () => {
    expect(
      describeIntakeAttempt(
        attemptFromOutcome(failed({ kind: "network" })),
      )?.lines.join("\n"),
    ).toContain("Windmillのジョブ一覧");
  });

  test("tells to check the Issues of the repository before sending again", () => {
    expect(
      describeIntakeAttempt(
        attemptFromOutcome(failed({ kind: "network" })),
      )?.lines.join("\n"),
    ).toContain("対象リポジトリのIssue");
  });

  test("tells to check for a manual_intake_submit job that is still waiting or running", () => {
    expect(
      describeIntakeAttempt(
        attemptFromOutcome(failed({ kind: "network" })),
      )?.lines.join("\n"),
    ).toContain("manual_intake_submitのジョブが待ちか実行中でないか");
  });

  test("explains that nothing exists yet while that job waits", () => {
    expect(
      describeIntakeAttempt(
        attemptFromOutcome(failed({ kind: "network" })),
      )?.lines.join("\n"),
    ).toContain("manual_intakeのジョブもIssueもまだありません");
  });

  test("has no job link when the result is not known", () => {
    expect(
      describeIntakeAttempt(attemptFromOutcome(failed({ kind: "network" })))
        ?.flowJobId,
    ).toBeNull();
  });
});
