import { describe, expect, test } from "bun:test";
import type { ApiError } from "../api/errors.ts";
import type { WriteOutcome } from "../api/executeWrite.ts";
import type { PrReviewSubmitResult } from "../api/guards/writeResults.ts";
import {
  attemptAfterSubmit,
  attemptFromOutcome,
  auditFailedNote,
  describePrReviewAttempt,
  type PrReviewAttempt,
  shouldRefreshPipeline,
  startsWaiting,
  submitControl,
} from "./prReviewOutcome.ts";
import { describePrReviewSubmitRefusal } from "./prReviewRefusal.ts";
import { ACTION_AUDIT_FAILED_NOTE } from "./writeNotices.ts";

const JOB = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

function done(
  result: PrReviewSubmitResult,
): WriteOutcome<PrReviewSubmitResult> {
  return { kind: "done", result };
}

function failed(
  error: ApiError,
  message = "failure message",
): WriteOutcome<PrReviewSubmitResult> {
  return { kind: "failed", error, message };
}

describe("the four results of a submit", () => {
  test("turns a refusal into the fixed sentence of its reason", () => {
    expect(
      attemptFromOutcome(done({ refused: true, reason: "already_reviewing" })),
    ).toEqual({
      kind: "refused",
      message: describePrReviewSubmitRefusal("already_reviewing"),
    });
  });

  test("turns a started flow into a submission", () => {
    expect(
      attemptFromOutcome(done({ refused: false, flow_job_id: JOB })),
    ).toEqual({ kind: "submitted", flowJobId: JOB, auditFailed: false });
  });

  test("keeps the failure sentence of a failure whose result is known", () => {
    expect(
      attemptFromOutcome(failed({ kind: "forbidden" }, "forbidden sentence")),
    ).toEqual({ kind: "failed", message: "forbidden sentence" });
  });

  test("treats a rejected request as a failure whose result is known", () => {
    expect(
      attemptFromOutcome(
        failed({ kind: "http", status: 400, detail: "bad" }, "bad request"),
      ).kind,
    ).toBe("failed");
  });

  test("treats a network failure as a result that is not known", () => {
    expect(
      attemptFromOutcome(failed({ kind: "network" }, "network sentence")),
    ).toEqual({ kind: "unknown", message: "network sentence" });
  });

  test("treats a server error as a result that is not known", () => {
    expect(
      attemptFromOutcome(
        failed({ kind: "http", status: 503, detail: "" }, "server sentence"),
      ).kind,
    ).toBe("unknown");
  });

  test("treats a failed job as a result that is not known", () => {
    expect(
      attemptFromOutcome(failed({ kind: "job_failed", message: "boom" })).kind,
    ).toBe("unknown");
  });
});

describe("the audit note", () => {
  test("marks a submission whose action record failed", () => {
    expect(
      attemptFromOutcome(
        done({ refused: false, flow_job_id: JOB, action_audit: "failed" }),
      ),
    ).toEqual({ kind: "submitted", flowJobId: JOB, auditFailed: true });
  });

  test("does not mark a submission whose action record was written", () => {
    expect(
      attemptFromOutcome(
        done({ refused: false, flow_job_id: JOB, action_audit: "recorded" }),
      ),
    ).toEqual({ kind: "submitted", flowJobId: JOB, auditFailed: false });
  });

  test("words the note like the other writes", () => {
    expect(
      auditFailedNote({ kind: "submitted", flowJobId: JOB, auditFailed: true }),
    ).toBe(ACTION_AUDIT_FAILED_NOTE);
  });

  test("has no note when the record was written", () => {
    expect(
      auditFailedNote({
        kind: "submitted",
        flowJobId: JOB,
        auditFailed: false,
      }),
    ).toBeNull();
  });

  test("has no note for a refusal", () => {
    expect(auditFailedNote({ kind: "refused", message: "no" })).toBeNull();
  });
});

describe("the notice of a submit", () => {
  test("shows a refusal as an error with the fixed sentence", () => {
    expect(
      describePrReviewAttempt({ kind: "refused", message: "sentence" }),
    ).toEqual({
      tone: "error",
      headline: "投入できませんでした",
      lines: ["sentence"],
    });
  });

  test("shows a failure whose result is known as an error with the failure sentence", () => {
    expect(
      describePrReviewAttempt({ kind: "failed", message: "sentence" }),
    ).toEqual({
      tone: "error",
      headline: "投入できませんでした",
      lines: ["sentence"],
    });
  });

  test("warns that a result which is not known may have been submitted", () => {
    expect(
      describePrReviewAttempt({ kind: "unknown", message: "sentence" })
        ?.headline,
    ).toBe("投入されたか分かりません");
  });

  test("keeps the failure sentence in the warning", () => {
    expect(
      describePrReviewAttempt({ kind: "unknown", message: "sentence" })
        ?.lines[0],
    ).toBe("sentence");
  });

  test("tells that a resend cannot start a second review and where to check", () => {
    expect(
      describePrReviewAttempt({ kind: "unknown", message: "sentence" })
        ?.lines[1],
    ).toBe(
      "前の投入が進行中の間は、再送しても二重には始まりません。作業項目の一覧かジョブの一覧で投入されたかを確かめてから、再送してください。",
    );
  });

  test("shows a warning tone for a result that is not known", () => {
    expect(
      describePrReviewAttempt({ kind: "unknown", message: "sentence" })?.tone,
    ).toBe("warning");
  });

  test("shows nothing for a submission, whose result the job result tells", () => {
    expect(
      describePrReviewAttempt({
        kind: "submitted",
        flowJobId: JOB,
        auditFailed: false,
      }),
    ).toBeNull();
  });
});

describe("the submit button", () => {
  test("is enabled and asks to start the review when idle", () => {
    expect(submitControl({ locked: false, waiting: false })).toEqual({
      disabled: false,
      label: "レビューを投入する",
    });
  });

  test("is disabled and says the submit is running while the shared lock is held", () => {
    expect(submitControl({ locked: true, waiting: false })).toEqual({
      disabled: true,
      label: "投入しています",
    });
  });

  test("is disabled while the result of the flow is awaited", () => {
    expect(submitControl({ locked: false, waiting: true })).toEqual({
      disabled: true,
      label: "レビューを投入する",
    });
  });

  test("says the submit is running when both hold", () => {
    expect(submitControl({ locked: true, waiting: true }).label).toBe(
      "投入しています",
    );
  });

  test("stays disabled from the moment the outcome arrives, until the result is read", () => {
    const attempt = attemptFromOutcome(
      done({ refused: false, flow_job_id: JOB }),
    );
    expect(
      submitControl({ locked: false, waiting: startsWaiting(attempt) })
        .disabled,
    ).toBe(true);
  });

  test("is enabled again after a refusal", () => {
    const attempt = attemptFromOutcome(
      done({ refused: true, reason: "already_reviewing" }),
    );
    expect(
      submitControl({ locked: false, waiting: startsWaiting(attempt) })
        .disabled,
    ).toBe(false);
  });

  test("is enabled again after a result that is not known, so a resend is not held back", () => {
    const attempt = attemptFromOutcome(failed({ kind: "network" }));
    expect(
      submitControl({ locked: false, waiting: startsWaiting(attempt) })
        .disabled,
    ).toBe(false);
  });
});

describe("waiting for the result of a started flow", () => {
  test("starts to wait when the flow started", () => {
    expect(
      startsWaiting({ kind: "submitted", flowJobId: JOB, auditFailed: false }),
    ).toBe(true);
  });

  test.each([
    { kind: "refused", message: "m" },
    { kind: "failed", message: "m" },
    { kind: "unknown", message: "m" },
  ] as const)("does not wait after %j", (attempt) => {
    expect(startsWaiting(attempt)).toBe(false);
  });
});

describe("clearing the previous result", () => {
  const PREVIOUS: PrReviewAttempt = { kind: "refused", message: "before" };

  test("clears the previous result when the submit started", () => {
    expect(attemptAfterSubmit(true, PREVIOUS)).toBeNull();
  });

  test("keeps the previous result when the submit could not start", () => {
    expect(attemptAfterSubmit(false, PREVIOUS)).toEqual(PREVIOUS);
  });

  test("keeps no result when there was none", () => {
    expect(attemptAfterSubmit(false, null)).toBeNull();
  });
});

describe("reading the list of work items again", () => {
  test("reads again the first time the review is seen to have started", () => {
    expect(
      shouldRefreshPipeline({ kind: "started", workItemId: 41 }, null, JOB),
    ).toBe(true);
  });

  test("does not read again for the same flow job", () => {
    expect(
      shouldRefreshPipeline({ kind: "started", workItemId: 41 }, JOB, JOB),
    ).toBe(false);
  });

  test("reads again for another flow job", () => {
    expect(
      shouldRefreshPipeline(
        { kind: "started", workItemId: 41 },
        "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c",
        JOB,
      ),
    ).toBe(true);
  });

  test.each([
    { kind: "waiting" },
    { kind: "unavailable" },
    { kind: "unreadable" },
    { kind: "refused", reason: "pr_closed" },
  ] as const)("does not read again for %j", (state) => {
    expect(shouldRefreshPipeline(state, null, JOB)).toBe(false);
  });
});
