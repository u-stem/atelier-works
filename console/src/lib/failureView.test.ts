import { describe, expect, test } from "bun:test";
import type { SummaryFailure } from "../api/guards/summary.ts";
import {
  describeFailure,
  describeRetryPlan,
  FAILURE_TEXT_LIMIT,
  workItemPath,
} from "./failureView.ts";

function failure(overrides: Partial<SummaryFailure> = {}): SummaryFailure {
  return {
    work_item_id: 7,
    kind: "issue",
    owner: "o",
    repo: "r",
    issue_number: 9,
    issue_url: "https://github.com/o/r/issues/9",
    pr_number: null,
    title: "Fix bug",
    status: "failed",
    updated_at: "2026-10-02T00:00:00.000Z",
    status_note: null,
    status_changed_at: "2026-10-02T00:00:00.000Z",
    job_failure_id: 11,
    flow_path: "f/factory/pipeline",
    job_id: "0f5a4a52-6a2c-4b35-8b2a-0d4c6c7f1e11",
    step: "generate",
    error: "boom",
    occurred_at: "2026-10-01T23:00:00.000Z",
    ...overrides,
  };
}

describe("workItemPath", () => {
  test("points at the work item detail route", () => {
    expect(workItemPath(7)).toBe("/items/7");
  });
});

describe("describeFailure title", () => {
  test("uses the title of the work item", () => {
    expect(describeFailure(failure()).title).toBe("Fix bug");
  });

  test("falls back to the work item reference without a title", () => {
    expect(describeFailure(failure({ title: null })).title).toBe("作業項目 #7");
  });

  test("replaces hidden characters in the title", () => {
    expect(describeFailure(failure({ title: "a‮b" })).title).toBe("a�b");
  });
});

describe("describeFailure labels", () => {
  test("labels the kind in Japanese", () => {
    expect(describeFailure(failure({ kind: "pr_fix" })).kindLabel).toBe(
      "PRの修正",
    );
  });

  test("labels the status in Japanese", () => {
    expect(describeFailure(failure()).statusLabel).toBe("失敗");
  });

  test("marks a failed work item with the failure tone", () => {
    expect(describeFailure(failure()).statusTone).toBe("failure");
  });

  test("marks a work item that needs a person with the warning tone", () => {
    expect(describeFailure(failure({ status: "needs_human" })).statusTone).toBe(
      "warning",
    );
  });

  test("marks an expired work item with the warning tone", () => {
    expect(describeFailure(failure({ status: "expired" })).statusTone).toBe(
      "warning",
    );
  });

  test("shows the repository", () => {
    expect(describeFailure(failure()).repoLabel).toBe("o/r");
  });

  test("shows the work item reference", () => {
    expect(describeFailure(failure()).workItemLabel).toBe("作業項目 #7");
  });
});

describe("describeFailure target", () => {
  test("labels the Issue of an Issue work item", () => {
    expect(describeFailure(failure()).targetLabel).toBe("Issue #9");
  });

  test("links the Issue only when the url has the GitHub shape", () => {
    expect(describeFailure(failure()).targetUrl).toBe(
      "https://github.com/o/r/issues/9",
    );
  });

  test("drops an Issue url that is not a GitHub url", () => {
    expect(
      describeFailure(failure({ issue_url: "javascript:alert(1)" })).targetUrl,
    ).toBeNull();
  });

  test("labels the pull request of a review work item", () => {
    expect(
      describeFailure(
        failure({ kind: "pr_review", issue_number: null, pr_number: 12 }),
      ).targetLabel,
    ).toBe("PR #12");
  });

  test("builds the pull request url from the repository", () => {
    expect(
      describeFailure(
        failure({
          kind: "pr_review",
          issue_number: null,
          issue_url: null,
          pr_number: 12,
        }),
      ).targetUrl,
    ).toBe("https://github.com/o/r/pull/12");
  });

  test("drops a pull request url built from an unsafe repository name", () => {
    expect(
      describeFailure(
        failure({
          kind: "pr_fix",
          owner: "o",
          repo: "r/../x",
          issue_number: null,
          issue_url: null,
          pr_number: 12,
        }),
      ).targetUrl,
    ).toBeNull();
  });

  test("has no target for an audit", () => {
    expect(
      describeFailure(
        failure({ kind: "audit", issue_number: null, issue_url: null }),
      ).targetLabel,
    ).toBeNull();
  });
});

describe("describeFailure record", () => {
  test("shows the flow and the step", () => {
    expect(describeFailure(failure()).flowLabel).toBe(
      "f/factory/pipeline / generate",
    );
  });

  test("shows the flow alone without a step", () => {
    expect(describeFailure(failure({ step: null })).flowLabel).toBe(
      "f/factory/pipeline",
    );
  });

  test("has no flow without a failure record", () => {
    expect(
      describeFailure(failure({ flow_path: null, step: "generate" })).flowLabel,
    ).toBeNull();
  });

  test("passes the job id on for the job link", () => {
    expect(describeFailure(failure()).jobId).toBe(
      "0f5a4a52-6a2c-4b35-8b2a-0d4c6c7f1e11",
    );
  });

  test("drops a job id that is not in the form of a job id", () => {
    expect(describeFailure(failure({ job_id: "../admin" })).jobId).toBeNull();
  });

  test("uses the time of the failure record", () => {
    expect(describeFailure(failure()).occurredAt).toBe(
      "2026-10-01T23:00:00.000Z",
    );
  });

  test("falls back to the time of the status change without a record", () => {
    expect(
      describeFailure(
        failure({
          job_failure_id: null,
          occurred_at: null,
          status_changed_at: "2026-10-02T01:00:00.000Z",
        }),
      ).occurredAt,
    ).toBe("2026-10-02T01:00:00.000Z");
  });

  test("falls back to the last update without any other time", () => {
    expect(
      describeFailure(
        failure({
          job_failure_id: null,
          occurred_at: null,
          status_changed_at: null,
        }),
      ).occurredAt,
    ).toBe("2026-10-02T00:00:00.000Z");
  });
});

describe("describeFailure error", () => {
  test("shows the error text", () => {
    expect(describeFailure(failure()).error?.text).toBe("boom");
  });

  test("has no error without a failure record", () => {
    expect(describeFailure(failure({ error: null })).error).toBeNull();
  });

  test("replaces hidden characters in the error text", () => {
    expect(describeFailure(failure({ error: "x​y" })).error?.text).toBe("x�y");
  });

  test("keeps line breaks in the error text", () => {
    expect(describeFailure(failure({ error: "a\r\nb" })).error?.text).toBe(
      "a\nb",
    );
  });

  test("does not flag a short error as cut", () => {
    expect(describeFailure(failure()).error?.truncated).toBe(false);
  });

  test("flags an error as cut at the limit of the summary", () => {
    expect(
      describeFailure(failure({ error: "e".repeat(FAILURE_TEXT_LIMIT) })).error
        ?.truncated,
    ).toBe(true);
  });

  test("counts characters, not UTF-16 units, against the limit", () => {
    expect(
      describeFailure(
        failure({ error: "\u{1F600}".repeat(FAILURE_TEXT_LIMIT - 1) }),
      ).error?.truncated,
    ).toBe(false);
  });
});

describe("describeFailure status note", () => {
  test("shows the note of the status change", () => {
    expect(
      describeFailure(failure({ status_note: "claude run failed" })).statusNote,
    ).toBe("claude run failed");
  });

  test("has no note without one", () => {
    expect(describeFailure(failure()).statusNote).toBeNull();
  });

  test("replaces hidden characters in the note", () => {
    expect(describeFailure(failure({ status_note: "a⁦b" })).statusNote).toBe(
      "a�b",
    );
  });
});

describe("describeRetryPlan", () => {
  test("restarts a review work item at the reviewing state", () => {
    expect(describeRetryPlan(failure({ kind: "pr_review" })).toLabel).toBe(
      "レビュー中",
    );
  });

  test("restarts a fix work item at the fixing state", () => {
    expect(describeRetryPlan(failure({ kind: "pr_fix" })).toLabel).toBe(
      "修正中",
    );
  });

  test("says an Issue restarts at the requirements or the implementation", () => {
    expect(describeRetryPlan(failure()).toLabel).toBe(
      "要件定義の生成中、または実装中",
    );
  });

  test("explains how an Issue chooses where to restart", () => {
    expect(describeRetryPlan(failure()).note).toBe(
      "承認済みの要件定義があれば実装から、なければ要件定義の作り直しから始めます。",
    );
  });

  test("has no note for a review work item", () => {
    expect(describeRetryPlan(failure({ kind: "pr_review" })).note).toBeNull();
  });

  test("shows the current state as the starting point", () => {
    expect(
      describeRetryPlan(failure({ status: "needs_human" })).fromLabel,
    ).toBe("人の対応待ち");
  });

  test("allows a retry of an Issue", () => {
    expect(describeRetryPlan(failure()).blockedReason).toBeNull();
  });

  test("refuses a retry of an audit", () => {
    expect(describeRetryPlan(failure({ kind: "audit" })).blockedReason).toBe(
      "監査は再実行できません。次の定期の監査が、失敗した期間を扱います。",
    );
  });

  test("leaves the destination of an unknown kind to the run", () => {
    expect(describeRetryPlan(failure({ kind: "future_kind" })).toLabel).toBe(
      "作業項目の種類に応じた状態",
    );
  });

  test("allows a retry of an unknown kind and leaves the refusal to the script", () => {
    expect(
      describeRetryPlan(failure({ kind: "future_kind" })).blockedReason,
    ).toBeNull();
  });
});
