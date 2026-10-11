import { describe, expect, test } from "bun:test";
import type {
  WorkItemApproval,
  WorkItemAttempt,
  WorkItemFixRound,
  WorkItemOverview,
  WorkItemReview,
  WorkItemRound,
} from "../api/guards/workItemDetail.ts";
import type { WorkItemFailure } from "../api/guards/workItemFailures.ts";
import type { WorkItemTransition } from "../api/guards/workItemTransitions.ts";
import {
  describeApproval,
  describeAttempt,
  describeFailureRecord,
  describeFixRound,
  describeOverview,
  describeReview,
  describeRound,
  describeTransition,
  detailLimitNote,
  formatCostUsd,
  formatDiffStat,
  groupRoundsByAttempt,
  hasModifierKey,
  ITEM_DETAIL_TABS,
  nextTabIndex,
  parseDetailTab,
  sortApprovalsNewestFirst,
} from "./itemDetailView.ts";

const T0 = "2026-10-08T00:00:00.000Z";
const T1 = "2026-10-09T00:00:00.000Z";
const JOB_A = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const JOB_B = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";

function overview(overrides: Partial<WorkItemOverview> = {}): WorkItemOverview {
  return {
    work_item_id: 7,
    kind: "issue",
    source: "issue",
    cycle: 1,
    owner: "o",
    repo: "r",
    issue_number: 9,
    issue_url: "https://github.com/o/r/issues/9",
    pr_number: 12,
    pr_url: "https://github.com/o/r/pull/12",
    branch: "factory/issue-9-wi-7",
    title: "Fix bug",
    status: "pr_open",
    attempt: 2,
    fix_round: 1,
    created_at: T0,
    updated_at: T1,
    status_note: null,
    total_cost_usd: 1.25,
    run_count: 3,
    ...overrides,
  };
}

function approval(overrides: Partial<WorkItemApproval> = {}): WorkItemApproval {
  return {
    approval_request_id: 5,
    kind: "requirements",
    status: "rejected",
    requested_at: T0,
    expires_at: null,
    decided_at: T1,
    decided_by: "reviewer",
    reason: "Scope is too wide",
    draft_attempt: 1,
    proposal_title: null,
    ...overrides,
  };
}

function round(overrides: Partial<WorkItemRound> = {}): WorkItemRound {
  return {
    round_id: 3,
    attempt: 1,
    round: 1,
    mode: "implement",
    outcome: "done",
    summary: "Implemented",
    gap_report: null,
    checks_skipped_reason: null,
    protected_changes: [],
    diff_stat: null,
    created_at: T0,
    ...overrides,
  };
}

function attempt(overrides: Partial<WorkItemAttempt> = {}): WorkItemAttempt {
  return {
    attempt: 2,
    summary: "Summary",
    created_at: T0,
    approval_request_id: 5,
    approval_status: "approved",
    ...overrides,
  };
}

function transition(
  overrides: Partial<WorkItemTransition> = {},
): WorkItemTransition {
  return {
    event_id: 31,
    from_status: "implementing",
    to_status: "pr_open",
    note: null,
    occurred_at: T0,
    job_id: null,
    root_job_id: null,
    ...overrides,
  };
}

function failure(overrides: Partial<WorkItemFailure> = {}): WorkItemFailure {
  return {
    job_failure_id: 11,
    flow_path: "f/factory/implement",
    job_id: JOB_A,
    root_job_id: null,
    step: "verify",
    error: "boom",
    occurred_at: T0,
    ...overrides,
  };
}

describe("parseDetailTab", () => {
  test("reads the tab of the query", () => {
    expect(parseDetailTab("approvals")).toBe("approvals");
  });

  test("falls back to the overview without a query", () => {
    expect(parseDetailTab(null)).toBe("overview");
  });

  test("falls back to the overview for an unknown tab", () => {
    expect(parseDetailTab("nope")).toBe("overview");
  });

  test("does not read a property inherited from Object", () => {
    expect(parseDetailTab("constructor")).toBe("overview");
  });
});

describe("ITEM_DETAIL_TABS", () => {
  test("lists the four tabs in order", () => {
    expect(ITEM_DETAIL_TABS.map((tab) => tab.id)).toEqual([
      "overview",
      "requirements",
      "rounds",
      "approvals",
    ]);
  });
});

describe("nextTabIndex", () => {
  test("moves right", () => {
    expect(nextTabIndex(0, "ArrowRight", 4)).toBe(1);
  });

  test("wraps from the last tab to the first on right", () => {
    expect(nextTabIndex(3, "ArrowRight", 4)).toBe(0);
  });

  test("moves left", () => {
    expect(nextTabIndex(2, "ArrowLeft", 4)).toBe(1);
  });

  test("wraps from the first tab to the last on left", () => {
    expect(nextTabIndex(0, "ArrowLeft", 4)).toBe(3);
  });

  test("goes to the first tab on Home", () => {
    expect(nextTabIndex(2, "Home", 4)).toBe(0);
  });

  test("goes to the last tab on End", () => {
    expect(nextTabIndex(1, "End", 4)).toBe(3);
  });

  test("ignores another key", () => {
    expect(nextTabIndex(1, "a", 4)).toBeNull();
  });
});

describe("describeOverview", () => {
  test("uses the issue title", () => {
    expect(describeOverview(overview()).title).toBe("Fix bug");
  });

  test("falls back to the issue number without a title", () => {
    expect(describeOverview(overview({ title: null })).title).toBe("Issue #9");
  });

  test("falls back to the work item number without a title and an issue", () => {
    expect(
      describeOverview(overview({ title: null, issue_number: null })).title,
    ).toBe("作業項目 #7");
  });

  test("replaces hidden characters in the title", () => {
    expect(describeOverview(overview({ title: "a‮b" })).title).toBe("a�b");
  });

  test("labels the status in Japanese", () => {
    expect(describeOverview(overview()).statusLabel).toBe("PR作成済み");
  });

  test("colors a failed status as a failure", () => {
    expect(describeOverview(overview({ status: "failed" })).statusVariant).toBe(
      "failure",
    );
  });

  test("labels the kind in Japanese", () => {
    expect(describeOverview(overview({ kind: "pr_fix" })).kindLabel).toBe(
      "PRの修正",
    );
  });

  test("joins the owner and the repo", () => {
    expect(describeOverview(overview()).repoLabel).toBe("o/r");
  });

  test("links the issue", () => {
    expect(describeOverview(overview()).issue).toEqual({
      label: "Issue #9",
      url: "https://github.com/o/r/issues/9",
    });
  });

  test("keeps the issue number but drops a link that is not GitHub", () => {
    expect(
      describeOverview(overview({ issue_url: "javascript:alert(1)" })).issue,
    ).toEqual({ label: "Issue #9", url: null });
  });

  test("has no issue without a number", () => {
    expect(
      describeOverview(overview({ issue_number: null, issue_url: null })).issue,
    ).toBeNull();
  });

  test("links the pull request", () => {
    expect(describeOverview(overview()).pr).toEqual({
      label: "PR #12",
      url: "https://github.com/o/r/pull/12",
    });
  });

  test("builds the pull request link from the number when the URL is missing", () => {
    expect(describeOverview(overview({ pr_url: null })).pr).toEqual({
      label: "PR #12",
      url: "https://github.com/o/r/pull/12",
    });
  });

  test("drops a pull request URL that is not GitHub and builds it from the number", () => {
    expect(
      describeOverview(overview({ pr_url: "https://evil.example/pull/12" })).pr,
    ).toEqual({ label: "PR #12", url: "https://github.com/o/r/pull/12" });
  });

  test("has no pull request without a number and a URL", () => {
    expect(
      describeOverview(overview({ pr_number: null, pr_url: null })).pr,
    ).toBeNull();
  });

  test("replaces hidden characters in the branch", () => {
    expect(describeOverview(overview({ branch: "a​b" })).branch).toBe("a�b");
  });

  test("has no branch when it is not recorded", () => {
    expect(describeOverview(overview({ branch: null })).branch).toBeNull();
  });

  test("replaces hidden characters in the status note", () => {
    expect(describeOverview(overview({ status_note: "x‮y" })).statusNote).toBe(
      "x�y",
    );
  });

  test("drops a status note that is only the pull request URL", () => {
    expect(
      describeOverview(
        overview({ status_note: "https://github.com/o/r/pull/12" }),
      ).statusNote,
    ).toBeNull();
  });

  test("drops a status note that is only the issue URL", () => {
    expect(
      describeOverview(
        overview({ status_note: "https://github.com/o/r/issues/9" }),
      ).statusNote,
    ).toBeNull();
  });

  test("drops a status note that is the pull request URL built from the number", () => {
    expect(
      describeOverview(
        overview({
          pr_url: null,
          status_note: "https://github.com/o/r/pull/12",
        }),
      ).statusNote,
    ).toBeNull();
  });

  test("drops a status note that matches the URL apart from surrounding whitespace", () => {
    expect(
      describeOverview(
        overview({ status_note: " https://github.com/o/r/pull/12\n" }),
      ).statusNote,
    ).toBeNull();
  });

  test("keeps a status note that equals a pull request URL that is not shown", () => {
    expect(
      describeOverview(
        overview({
          pr_number: null,
          pr_url: "https://evil.example/pull/12",
          status_note: "https://evil.example/pull/12",
        }),
      ).statusNote,
    ).toBe("https://evil.example/pull/12");
  });

  test("keeps a status note that is only another URL", () => {
    expect(
      describeOverview(
        overview({ status_note: "https://github.com/o/r/pull/3" }),
      ).statusNote,
    ).toBe("https://github.com/o/r/pull/3");
  });

  test("keeps a status note that has a sentence around a URL", () => {
    expect(
      describeOverview(
        overview({ status_note: "opened https://github.com/o/r/pull/12" }),
      ).statusNote,
    ).toBe("opened https://github.com/o/r/pull/12");
  });

  test("formats the cost", () => {
    expect(describeOverview(overview()).costLabel).toBe("$1.25(3回の実行)");
  });
});

describe("formatCostUsd", () => {
  test("says nothing is recorded for null", () => {
    expect(formatCostUsd(null)).toBe("記録なし");
  });

  test("rounds to cents", () => {
    expect(formatCostUsd(0.126)).toBe("$0.13");
  });

  test("does not show a positive cost as zero", () => {
    expect(formatCostUsd(0.004)).toBe("$0.01未満");
  });

  test("shows zero as zero", () => {
    expect(formatCostUsd(0)).toBe("$0.00");
  });
});

describe("formatDiffStat", () => {
  test("shows the files and the lines in words", () => {
    expect(formatDiffStat({ files: 3, added: 17, deleted: 0 })).toBe(
      "3ファイル・追加17行・削除0行",
    );
  });

  test("returns null without a stat", () => {
    expect(formatDiffStat(null)).toBeNull();
  });
});

describe("describeAttempt", () => {
  test("links the requirements document of an older attempt by its number", () => {
    expect(describeAttempt(7, attempt(), false).path).toBe(
      "/items/7/requirements?attempt=2",
    );
  });

  test("links the latest attempt without a number", () => {
    expect(describeAttempt(7, attempt(), true).path).toBe(
      "/items/7/requirements",
    );
  });

  test("marks the link of the latest attempt", () => {
    expect(describeAttempt(7, attempt(), true).linkLabel).toBe(
      "要件定義書を開く(試行 2・最新)",
    );
  });

  test("names the attempt in the link of an older attempt", () => {
    expect(describeAttempt(7, attempt(), false).linkLabel).toBe(
      "要件定義書を開く(試行 2)",
    );
  });

  test("labels the approval status", () => {
    expect(describeAttempt(7, attempt(), false).approvalLabel).toBe("承認済み");
  });

  test("has no approval label without an approval request", () => {
    expect(
      describeAttempt(
        7,
        attempt({ approval_request_id: null, approval_status: null }),
        false,
      ).approvalLabel,
    ).toBeNull();
  });

  test("replaces hidden characters in the summary", () => {
    expect(describeAttempt(7, attempt({ summary: "a‮b" }), false).summary).toBe(
      "a�b",
    );
  });
});

describe("describeApproval", () => {
  test("keeps the reason of a rejection", () => {
    expect(describeApproval(approval()).reason).toBe("Scope is too wide");
  });

  test("keeps who decided", () => {
    expect(describeApproval(approval()).decidedBy).toBe("reviewer");
  });

  test("labels the rejected status", () => {
    expect(describeApproval(approval()).statusLabel).toBe("却下");
  });

  test("colors a rejection as a failure", () => {
    expect(describeApproval(approval()).statusVariant).toBe("failure");
  });

  test("colors a pending request as a warning", () => {
    expect(
      describeApproval(approval({ status: "pending" })).statusVariant,
    ).toBe("warning");
  });

  test("colors an approval as a success", () => {
    expect(
      describeApproval(approval({ status: "approved" })).statusVariant,
    ).toBe("success");
  });

  test("leaves an approval status that is not known yet plain", () => {
    expect(describeApproval(approval({ status: "zeta" })).statusVariant).toBe(
      "muted",
    );
  });

  test("labels the kind", () => {
    expect(describeApproval(approval()).kindLabel).toBe("要件定義");
  });

  test("points at the attempt of a requirements request", () => {
    expect(describeApproval(approval()).subject).toBe("試行 1");
  });

  test("points at the title of an issue proposal", () => {
    expect(
      describeApproval(
        approval({
          kind: "issue_proposal",
          draft_attempt: null,
          proposal_title: "Add a cache",
        }),
      ).subject,
    ).toBe("Add a cache");
  });

  test("has no subject without an attempt and a title", () => {
    expect(
      describeApproval(approval({ draft_attempt: null })).subject,
    ).toBeNull();
  });

  test("replaces hidden characters in the reason", () => {
    expect(describeApproval(approval({ reason: "no‮k" })).reason).toBe("no�k");
  });

  test("treats a blank reason as none", () => {
    expect(describeApproval(approval({ reason: "  \n" })).reason).toBeNull();
  });

  test("replaces hidden characters in who decided", () => {
    expect(describeApproval(approval({ decided_by: "a​b" })).decidedBy).toBe(
      "a�b",
    );
  });

  test("has no decision time while pending", () => {
    expect(
      describeApproval(
        approval({ status: "pending", decided_at: null, decided_by: null }),
      ).decidedAt,
    ).toBeNull();
  });
});

describe("sortApprovalsNewestFirst", () => {
  test("puts the later request first", () => {
    expect(
      sortApprovalsNewestFirst([
        approval({ approval_request_id: 1, requested_at: T0 }),
        approval({ approval_request_id: 2, requested_at: T1 }),
      ]).map((row) => row.approval_request_id),
    ).toEqual([2, 1]);
  });

  test("puts the larger id first for the same time", () => {
    expect(
      sortApprovalsNewestFirst([
        approval({ approval_request_id: 1 }),
        approval({ approval_request_id: 2 }),
      ]).map((row) => row.approval_request_id),
    ).toEqual([2, 1]);
  });

  test("does not change the given list", () => {
    const rows = [
      approval({ approval_request_id: 1 }),
      approval({ approval_request_id: 2 }),
    ];
    sortApprovalsNewestFirst(rows);
    expect(rows.map((row) => row.approval_request_id)).toEqual([1, 2]);
  });
});

describe("groupRoundsByAttempt", () => {
  test("puts the latest attempt first", () => {
    expect(
      groupRoundsByAttempt([
        round({ round_id: 1, attempt: 1 }),
        round({ round_id: 2, attempt: 2 }),
      ]).map((group) => group.attempt),
    ).toEqual([2, 1]);
  });

  test("keeps the rounds of an attempt in order", () => {
    expect(
      groupRoundsByAttempt([
        round({ round_id: 2, attempt: 1, round: 2 }),
        round({ round_id: 1, attempt: 1, round: 1 }),
      ])[0]?.rounds.map((row) => row.round),
    ).toEqual([1, 2]);
  });

  test("returns no group for no rounds", () => {
    expect(groupRoundsByAttempt([])).toEqual([]);
  });
});

describe("describeRound", () => {
  test("labels the mode", () => {
    expect(describeRound(round({ mode: "fix" })).modeLabel).toBe("検査の修正");
  });

  test("labels the outcome", () => {
    expect(
      describeRound(round({ outcome: "requirements_gap" })).outcomeLabel,
    ).toBe("要件の不足");
  });

  test("colors a failed check as a failure", () => {
    expect(
      describeRound(round({ outcome: "check_failed" })).outcomeVariant,
    ).toBe("failure");
  });

  test("leaves an outcome that is not known yet plain", () => {
    expect(describeRound(round({ outcome: "zeta" })).outcomeVariant).toBe(
      "muted",
    );
  });

  test("shows the raw value of an unknown outcome", () => {
    expect(describeRound(round({ outcome: "new_one" })).outcomeLabel).toBe(
      "不明(new_one)",
    );
  });

  test("replaces hidden characters in the summary", () => {
    expect(describeRound(round({ summary: "a‮b" })).summary).toBe("a�b");
  });

  test("replaces hidden characters in the gap report", () => {
    expect(describeRound(round({ gap_report: "g‮r" })).gapReport).toBe("g�r");
  });

  test("replaces hidden characters in a protected path", () => {
    expect(
      describeRound(round({ protected_changes: ["a‮b"] })).protectedChanges,
    ).toEqual(["a�b"]);
  });

  test("shows the diff stat", () => {
    expect(
      describeRound(round({ diff_stat: { files: 1, added: 2, deleted: 3 } }))
        .diffLabel,
    ).toBe("1ファイル・追加2行・削除3行");
  });
});

function review(overrides: Partial<WorkItemReview> = {}): WorkItemReview {
  return {
    review_id: 1,
    head_sha: "abc1234",
    verdict: "comment",
    finding_count: 2,
    posted_review_id: null,
    created_at: T0,
    ...overrides,
  };
}

describe("describeReview", () => {
  test("shortens the commit to seven characters", () => {
    expect(
      describeReview(review({ head_sha: "0123456789abcdef" })).shaLabel,
    ).toBe("0123456");
  });

  test("labels the verdict", () => {
    expect(
      describeReview(review({ verdict: "request_changes" })).verdictLabel,
    ).toBe("修正を依頼");
  });

  test("leaves a verdict that is not known yet plain", () => {
    expect(describeReview(review({ verdict: "zeta" })).verdictVariant).toBe(
      "muted",
    );
  });

  test("counts the findings", () => {
    expect(describeReview(review({ finding_count: 3 })).findingLabel).toBe(
      "指摘 3件",
    );
  });
});

describe("describeFixRound", () => {
  const fixRound: WorkItemFixRound = {
    fix_round_id: 1,
    round: 2,
    outcome: "blocked",
    trigger_review_count: 1,
    reply_count: 3,
    commit_count: 0,
    created_at: T0,
  };

  test("labels the round", () => {
    expect(describeFixRound(fixRound).roundLabel).toBe("修正 2");
  });

  test("labels the outcome", () => {
    expect(describeFixRound(fixRound).outcomeLabel).toBe("ブロック");
  });

  test("leaves a fix outcome that is not known yet plain", () => {
    expect(
      describeFixRound({ ...fixRound, outcome: "zeta" }).outcomeVariant,
    ).toBe("muted");
  });

  test("counts the reviews, replies and commits", () => {
    expect(describeFixRound(fixRound).countsLabel).toBe(
      "対象のレビュー 1件・返信 3件・コミット 0件",
    );
  });
});

describe("describeTransition", () => {
  test("labels both statuses", () => {
    expect(describeTransition(transition())).toMatchObject({
      fromLabel: "実装中",
      toLabel: "PR作成済み",
    });
  });

  test("has no source status for the first transition", () => {
    expect(
      describeTransition(transition({ from_status: null })).fromLabel,
    ).toBeNull();
  });

  test("has no job link without a job", () => {
    expect(describeTransition(transition()).jobs).toEqual([]);
  });

  test("shows one job link when the step is the flow itself", () => {
    expect(
      describeTransition(transition({ job_id: JOB_A, root_job_id: JOB_A }))
        .jobs,
    ).toEqual([{ label: "ジョブ", jobId: JOB_A }]);
  });

  test("shows the step and the flow when they differ", () => {
    expect(
      describeTransition(transition({ job_id: JOB_A, root_job_id: JOB_B }))
        .jobs,
    ).toEqual([
      { label: "ステップのジョブ", jobId: JOB_A },
      { label: "フローのジョブ", jobId: JOB_B },
    ]);
  });

  test("shows only the flow when the step job is missing", () => {
    expect(
      describeTransition(transition({ job_id: null, root_job_id: JOB_B })).jobs,
    ).toEqual([{ label: "フローのジョブ", jobId: JOB_B }]);
  });

  test("replaces hidden characters in the note", () => {
    expect(describeTransition(transition({ note: "a‮b" })).note).toBe("a�b");
  });

  test("keeps a note that is only a URL", () => {
    expect(
      describeTransition(transition({ note: "https://github.com/o/r/pull/12" }))
        .note,
    ).toBe("https://github.com/o/r/pull/12");
  });
});

describe("describeFailureRecord", () => {
  test("joins the flow and the step", () => {
    expect(describeFailureRecord(failure()).flowLabel).toBe(
      "f/factory/implement / verify",
    );
  });

  test("shows only the flow without a step", () => {
    expect(describeFailureRecord(failure({ step: null })).flowLabel).toBe(
      "f/factory/implement",
    );
  });

  test("replaces hidden characters in the error", () => {
    expect(describeFailureRecord(failure({ error: "a‮b" })).error.text).toBe(
      "a�b",
    );
  });

  test("marks an error that reached the length limit as cut", () => {
    expect(
      describeFailureRecord(failure({ error: "x".repeat(4000) })).error
        .truncated,
    ).toBe(true);
  });

  test("does not mark a short error as cut", () => {
    expect(describeFailureRecord(failure()).error.truncated).toBe(false);
  });

  test("labels the recorded job and its flow apart from a transition", () => {
    expect(
      describeFailureRecord(failure({ job_id: JOB_A, root_job_id: JOB_B }))
        .jobs,
    ).toEqual([
      { label: "失敗したジョブ", jobId: JOB_A },
      { label: "記録したジョブのフロー", jobId: JOB_B },
    ]);
  });

  test("shows one link when the failed job is its own root", () => {
    expect(
      describeFailureRecord(failure({ job_id: JOB_A, root_job_id: JOB_A }))
        .jobs,
    ).toEqual([{ label: "失敗したジョブ", jobId: JOB_A }]);
  });

  test("links only the failed job when the root is not recorded", () => {
    expect(describeFailureRecord(failure()).jobs).toEqual([
      { label: "失敗したジョブ", jobId: JOB_A },
    ]);
  });
});

describe("detailLimitNote", () => {
  test("says nothing below the limit", () => {
    expect(detailLimitNote(19, 20)).toBeNull();
  });

  test("warns that older records are not shown at the limit", () => {
    expect(detailLimitNote(20, 20)).toBe(
      "新しい順に20件まで表示しています。それより古い記録は表示していません。",
    );
  });
});

describe("hasModifierKey", () => {
  test("is true while Alt is held", () => {
    expect(
      hasModifierKey({ altKey: true, ctrlKey: false, metaKey: false }),
    ).toBe(true);
  });

  test("is true while Ctrl is held", () => {
    expect(
      hasModifierKey({ altKey: false, ctrlKey: true, metaKey: false }),
    ).toBe(true);
  });

  test("is true while Meta is held", () => {
    expect(
      hasModifierKey({ altKey: false, ctrlKey: false, metaKey: true }),
    ).toBe(true);
  });

  test("is false for a plain key", () => {
    expect(
      hasModifierKey({ altKey: false, ctrlKey: false, metaKey: false }),
    ).toBe(false);
  });
});
