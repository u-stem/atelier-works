import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { checkA11y } from "../../lib/a11yRules.ts";
import type { PrReviewAttempt } from "../../lib/prReviewOutcome.ts";
import type { PrReviewResultState } from "../../lib/prReviewResult.ts";
import { ACTION_AUDIT_FAILED_NOTE } from "../../lib/writeNotices.ts";
import {
  PrReviewAttemptNotice,
  PrReviewResult,
  PrReviewResultPanel,
} from "./PrReviewResult.tsx";

const JOB = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

function draw(node: ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function panel(state: PrReviewResultState, retrying = false): string {
  return draw(
    <PrReviewResultPanel
      state={state}
      flowJobId={JOB}
      onRetry={() => undefined}
      retrying={retrying}
    />,
  );
}

function notice(attempt: PrReviewAttempt): string {
  return draw(<PrReviewAttemptNotice attempt={attempt} />);
}

const STATES: readonly PrReviewResultState[] = [
  { kind: "waiting" },
  { kind: "unavailable" },
  { kind: "unreadable" },
  { kind: "started", workItemId: 41 },
  { kind: "refused", reason: "pr_closed" },
];

const ATTEMPTS: readonly PrReviewAttempt[] = [
  { kind: "refused", message: "断りの文" },
  { kind: "failed", message: "失敗の文" },
  { kind: "unknown", message: "不明の文" },
  { kind: "submitted", flowJobId: JOB, auditFailed: true },
];

describe("the result panel", () => {
  test("says the result is awaited", () => {
    expect(panel({ kind: "waiting" })).toContain("結果を待っています");
  });

  test("links the awaited job", () => {
    expect(panel({ kind: "waiting" })).toContain(`href="/jobs/${JOB}"`);
  });

  test("offers no retry while waiting", () => {
    expect(panel({ kind: "waiting" })).not.toContain("もう一度取得する");
  });

  test("says the result cannot be fetched", () => {
    expect(panel({ kind: "unavailable" })).toContain("結果を取得できません");
  });

  test("offers a retry when the result cannot be fetched", () => {
    expect(panel({ kind: "unavailable" })).toContain("もう一度取得する");
  });

  test("links the job when the result cannot be fetched", () => {
    expect(panel({ kind: "unavailable" })).toContain(`href="/jobs/${JOB}"`);
  });

  test("disables the retry while it reads again", () => {
    expect(panel({ kind: "unavailable" }, true)).toMatch(
      /<button[^>]*disabled=""[^>]*>もう一度取得する/,
    );
  });

  test("leaves the retry enabled when it is not reading", () => {
    expect(panel({ kind: "unavailable" })).not.toMatch(
      /<button[^>]*disabled=""[^>]*>もう一度取得する/,
    );
  });

  test("tells to open the job when the result cannot be read", () => {
    expect(panel({ kind: "unreadable" })).toContain(
      "結果を読み取れません。ジョブを開いて確認してください",
    );
  });

  test("links the job when the result cannot be read", () => {
    expect(panel({ kind: "unreadable" })).toContain(`href="/jobs/${JOB}"`);
  });

  test("offers no retry when the result cannot be read", () => {
    expect(panel({ kind: "unreadable" })).not.toContain("もう一度取得する");
  });

  test("says the review started", () => {
    expect(panel({ kind: "started", workItemId: 41 })).toContain(
      "レビューを始めました",
    );
  });

  test("links the work item of a started review", () => {
    expect(panel({ kind: "started", workItemId: 41 })).toContain(
      'href="/items/41"',
    );
  });

  test("names the work item in the link", () => {
    expect(panel({ kind: "started", workItemId: 41 })).toContain(
      "作業項目 #41を開く",
    );
  });

  test("draws the fixed sentence of a refusal", () => {
    expect(panel({ kind: "refused", reason: "pr_closed" })).toContain(
      "PRはすでに閉じています。",
    );
  });

  test("links no work item for a refusal, which has none", () => {
    expect(panel({ kind: "refused", reason: "pr_closed" })).not.toContain(
      'href="/items/',
    );
  });

  test.each(STATES)("draws %j without a11y violations", (state) => {
    expect(checkA11y(panel(state), { headingStart: 1 })).toEqual([]);
  });
});

describe("the result of a started flow", () => {
  test("waits for the result of a job that has not been read yet", () => {
    expect(
      draw(
        <PrReviewResult flowJobId={JOB} onWaitingChange={() => undefined} />,
      ),
    ).toContain("結果を待っています");
  });
});

describe("the notice of a submit", () => {
  test("draws the fixed sentence of a refusal", () => {
    expect(notice({ kind: "refused", message: "断りの文" })).toContain(
      "断りの文",
    );
  });

  test("says that a refused submit was not made", () => {
    expect(notice({ kind: "refused", message: "断りの文" })).toContain(
      "投入できませんでした",
    );
  });

  test("draws the failure sentence of a failure whose result is known", () => {
    expect(notice({ kind: "failed", message: "失敗の文" })).toContain(
      "失敗の文",
    );
  });

  test("warns that a submit may have been made", () => {
    expect(notice({ kind: "unknown", message: "不明の文" })).toContain(
      "投入されたか分かりません",
    );
  });

  test("tells that a resend does not start a second review", () => {
    expect(notice({ kind: "unknown", message: "不明の文" })).toContain(
      "再送しても、同じPRのレビューが二重に始まることはありません。",
    );
  });

  test("draws the note of a failed action record next to the result", () => {
    expect(
      notice({ kind: "submitted", flowJobId: JOB, auditFailed: true }),
    ).toContain(ACTION_AUDIT_FAILED_NOTE);
  });

  test("draws nothing for a submission whose record was written", () => {
    expect(
      notice({ kind: "submitted", flowJobId: JOB, auditFailed: false }),
    ).toBe("");
  });

  test.each(ATTEMPTS)("draws %j without a11y violations", (attempt) => {
    expect(checkA11y(notice(attempt), { headingStart: 1 })).toEqual([]);
  });
});
