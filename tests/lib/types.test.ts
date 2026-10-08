import { describe, expect, test } from "bun:test";
import {
  assertBranchName,
  assertGitHubName,
  assertSha,
  capToDeadline,
  IMPLEMENT_ROUND_MODES,
  IMPLEMENT_ROUND_OUTCOMES,
  isImplementDiffStat,
  isImplementRoundMode,
  isImplementRoundOutcome,
  TERMINAL_WORK_ITEM_STATUSES,
  WORK_ITEM_KINDS,
  WORK_ITEM_SOURCES,
  WORK_ITEM_STATUSES,
} from "../../f/factory/lib/types.ts";

describe("assertGitHubName", () => {
  test("accepts a plain login", () => {
    expect(() => assertGitHubName("octo-owner")).not.toThrow();
  });

  test("accepts a name with digits and dots", () => {
    expect(() => assertGitHubName("my.repo123")).not.toThrow();
  });

  test("rejects a name starting with a dot", () => {
    expect(() => assertGitHubName(".hidden")).toThrow();
  });

  test("rejects a bare dot", () => {
    expect(() => assertGitHubName(".")).toThrow();
  });

  test("rejects a bare double dot", () => {
    expect(() => assertGitHubName("..")).toThrow();
  });

  test("rejects an empty string", () => {
    expect(() => assertGitHubName("")).toThrow();
  });

  test("rejects a name containing a slash", () => {
    expect(() => assertGitHubName("owner/repo")).toThrow();
  });

  test("rejects a name containing whitespace", () => {
    expect(() => assertGitHubName("owner name")).toThrow();
  });

  test("rejects a name containing a shell metacharacter", () => {
    expect(() => assertGitHubName("owner;rm -rf")).toThrow();
  });
});

describe("assertSha", () => {
  test("accepts a 7-character short SHA", () => {
    expect(() => assertSha("abc1234")).not.toThrow();
  });

  test("accepts a full 40-character SHA", () => {
    expect(() => assertSha("a".repeat(40))).not.toThrow();
  });

  test("rejects a SHA shorter than 7 characters", () => {
    expect(() => assertSha("abc123")).toThrow();
  });

  test("rejects a SHA longer than 40 characters", () => {
    expect(() => assertSha("a".repeat(41))).toThrow();
  });

  test("rejects uppercase hex digits", () => {
    expect(() => assertSha("ABC1234")).toThrow();
  });

  test("rejects a non-hex character", () => {
    expect(() => assertSha("xyz1234")).toThrow();
  });
});

describe("assertBranchName", () => {
  test("accepts a plain branch name", () => {
    expect(() => assertBranchName("feature/add-thing")).not.toThrow();
  });

  test("rejects an empty string", () => {
    expect(() => assertBranchName("")).toThrow();
  });

  test("rejects a name starting with a dash (argv injection risk)", () => {
    expect(() => assertBranchName("--force")).toThrow();
  });

  test("rejects a name containing two consecutive dots", () => {
    expect(() => assertBranchName("feature..evil")).toThrow();
  });

  test("rejects a name containing a control character", () => {
    expect(() => assertBranchName("feature\nrm -rf")).toThrow();
  });

  test("rejects a name containing whitespace", () => {
    expect(() => assertBranchName("feature branch")).toThrow();
  });

  test("rejects a name containing a colon", () => {
    expect(() => assertBranchName("feature:evil")).toThrow();
  });

  test("rejects a name containing a tilde", () => {
    expect(() => assertBranchName("feature~1")).toThrow();
  });

  test("rejects a name containing a caret", () => {
    expect(() => assertBranchName("feature^1")).toThrow();
  });

  test("rejects a name containing a question mark", () => {
    expect(() => assertBranchName("feature?")).toThrow();
  });

  test("rejects a name containing an asterisk", () => {
    expect(() => assertBranchName("feature*")).toThrow();
  });

  test("rejects a name containing an open bracket", () => {
    expect(() => assertBranchName("feature[1]")).toThrow();
  });

  test("rejects a name containing a backslash", () => {
    expect(() => assertBranchName("feature\\evil")).toThrow();
  });

  test("rejects a name ending with a slash", () => {
    expect(() => assertBranchName("feature/")).toThrow();
  });

  test("rejects a name ending with .lock", () => {
    expect(() => assertBranchName("feature.lock")).toThrow();
  });
});

describe("TERMINAL_WORK_ITEM_STATUSES", () => {
  test("treats rereview_requested as terminal (pr_fix's success end state)", () => {
    // `poll_issues`の照合は終端でない行だけを調べる。
    // ここに含めないと、完了した`pr_fix`の行を孤立した行として失敗にしてしまう。
    expect(TERMINAL_WORK_ITEM_STATUSES).toContain("rereview_requested");
  });
});

describe("audit work item vocabulary", () => {
  test("audit is a work item kind", () => {
    expect(WORK_ITEM_KINDS).toContain("audit");
  });

  test("schedule is a work item source", () => {
    expect(WORK_ITEM_SOURCES).toContain("schedule");
  });

  test("auditing is a status", () => {
    expect(WORK_ITEM_STATUSES).toContain("auditing");
  });

  test("audited is terminal", () => {
    expect(TERMINAL_WORK_ITEM_STATUSES).toContain("audited");
  });
});

describe("implement work item vocabulary (工程3)", () => {
  test("pr_open is terminal (implement's success end state; keeps it out of listActive/reconcile)", () => {
    expect(TERMINAL_WORK_ITEM_STATUSES).toContain("pr_open");
  });

  test("lists implement and fix as the two round modes", () => {
    expect(IMPLEMENT_ROUND_MODES).toEqual(["implement", "fix"]);
  });

  test("lists the six round outcomes in the migration's CHECK order", () => {
    expect(IMPLEMENT_ROUND_OUTCOMES).toEqual([
      "done",
      "requirements_gap",
      "check_failed",
      "checks_skipped",
      "stalled",
      "error",
    ]);
  });

  test("isImplementRoundMode accepts fix", () => {
    expect(isImplementRoundMode("fix")).toBe(true);
  });

  test("isImplementRoundMode rejects verify", () => {
    expect(isImplementRoundMode("verify")).toBe(false);
  });

  test("isImplementRoundOutcome accepts stalled", () => {
    expect(isImplementRoundOutcome("stalled")).toBe(true);
  });

  test("isImplementRoundOutcome rejects blocked (a fix_rounds outcome, not an implement one)", () => {
    expect(isImplementRoundOutcome("blocked")).toBe(false);
  });

  test("isImplementDiffStat accepts {files, added, deleted}", () => {
    expect(isImplementDiffStat({ files: 3, added: 10, deleted: 2 })).toBe(true);
  });

  test("isImplementDiffStat rejects a stat missing deleted", () => {
    expect(isImplementDiffStat({ files: 3, added: 10 })).toBe(false);
  });
});

describe("capToDeadline", () => {
  test("keeps the timeout when the deadline is further away", () => {
    expect(capToDeadline(1_000, 10_000, 0)).toBe(1_000);
  });

  test("caps the timeout at the time left", () => {
    expect(capToDeadline(1_000, 10_500, 10_000)).toBe(500);
  });

  test("returns 0 past the deadline", () => {
    expect(capToDeadline(1_000, 10_000, 12_000)).toBe(0);
  });

  test("returns 0 for a deadline that is not a finite number", () => {
    expect(capToDeadline(1_000, Number.NaN, 0)).toBe(0);
  });
});
