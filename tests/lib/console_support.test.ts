import { describe, expect, test } from "bun:test";
import {
  ACTIONABLE_WORK_ITEM_STATUSES,
  countHiddenCharacters,
  countHtmlCommentOpeners,
  INFO_NOTICE_KINDS,
  INFO_NOTICE_WINDOW_DAYS,
  isNoticeResolvable,
  NOTICE_SEVERITY,
  noticeSeverity,
  truncateChars,
  UNRESOLVABLE_NOTICE_KINDS,
} from "../../f/factory/lib/console_support.ts";

/** `docs/operations.md`の「通知の種類」の表から、種類の列を取り出す。 */
async function documentedNoticeKinds(): Promise<string[]> {
  const doc = await Bun.file("docs/operations.md").text();
  const start = doc.indexOf("### 通知の種類");
  const rest = doc.slice(start + 1);
  const end = rest.search(/\n#{2,3} /);
  const section = end === -1 ? rest : rest.slice(0, end);
  return [...section.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1] ?? "");
}

describe("noticeSeverity", () => {
  test("returns info for a kind that needs no action", () => {
    expect(noticeSeverity("claim_race_lost")).toBe("info");
  });

  test("returns action for a kind that needs a person", () => {
    expect(noticeSeverity("cleanup_db_failed")).toBe("action");
  });

  test("returns info for a kind whose work item is already a failure row", () => {
    expect(noticeSeverity("implement_needs_human")).toBe("info");
  });

  test("returns action for a launch failure that can leave no failure row", () => {
    expect(noticeSeverity("implement_launch_failed")).toBe("action");
  });

  test("treats a held draw.io viewer bump as action", () => {
    expect(noticeSeverity("drawio_viewer_bump_held")).toBe("action");
  });

  test("treats a failed main CI as action", () => {
    expect(noticeSeverity("main_ci_failed")).toBe("action");
  });

  test("treats a denied main CI check as action", () => {
    expect(noticeSeverity("main_ci_check_denied")).toBe("action");
  });

  test("treats a failed pull request CI as action", () => {
    expect(noticeSeverity("pr_ci_failed")).toBe("action");
  });

  test("treats a merge conflict of a pull request as action", () => {
    expect(noticeSeverity("pr_conflict")).toBe("action");
  });

  test("treats a denied pull request CI check as action", () => {
    expect(noticeSeverity("pr_ci_check_denied")).toBe("action");
  });

  test("returns action for an unknown kind", () => {
    expect(noticeSeverity("some_future_kind")).toBe("action");
  });

  test("returns action for a name that exists on Object.prototype", () => {
    expect(noticeSeverity("constructor")).toBe("action");
  });

  test("returns action for the console fetch kinds", () => {
    expect([
      noticeSeverity("console_fetch_failed"),
      noticeSeverity("console_fetch_stale"),
    ]).toEqual(["action", "action"]);
  });
});

describe("host_action_required", () => {
  test("is an action notice", () => {
    expect(noticeSeverity("host_action_required")).toBe("action");
  });

  test("can be resolved from the Console", () => {
    expect(isNoticeResolvable("host_action_required")).toBe(true);
  });
});

describe("INFO_NOTICE_KINDS", () => {
  test("lists exactly the kinds whose severity is info", () => {
    expect([...INFO_NOTICE_KINDS].sort()).toEqual(
      Object.entries(NOTICE_SEVERITY)
        .filter(([, severity]) => severity === "info")
        .map(([kind]) => kind)
        .sort(),
    );
  });

  test("contains the ten kinds that need no action", () => {
    expect([...INFO_NOTICE_KINDS].sort()).toEqual([
      "approval_notify_failed",
      "claim_race_lost",
      "cleanup_worktrees_skipped",
      "fix_feedback_association_excluded",
      "fork_head_denied",
      "implement_needs_human",
      "labeler_denied",
      "supersede_failed",
      "unsandboxed_check_commands",
      "workspace_disk_usage",
    ]);
  });
});

describe("UNRESOLVABLE_NOTICE_KINDS", () => {
  test("contains the security-related kinds", () => {
    expect([...UNRESOLVABLE_NOTICE_KINDS].sort()).toEqual([
      "fix_feedback_association_excluded",
      "labeler_denied",
      "unsandboxed_check_commands",
    ]);
  });

  test("is a subset of the info kinds", () => {
    expect(
      UNRESOLVABLE_NOTICE_KINDS.every((kind) =>
        INFO_NOTICE_KINDS.includes(kind),
      ),
    ).toBe(true);
  });
});

describe("isNoticeResolvable", () => {
  test("returns false for an unresolvable kind", () => {
    expect(isNoticeResolvable("unsandboxed_check_commands")).toBe(false);
  });

  test("returns true for an ordinary kind", () => {
    expect(isNoticeResolvable("cleanup_db_failed")).toBe(true);
  });

  test("returns true for an unknown kind", () => {
    expect(isNoticeResolvable("some_future_kind")).toBe(true);
  });
});

describe("work item constants", () => {
  test("ACTIONABLE_WORK_ITEM_STATUSES is failed, needs_human and expired", () => {
    expect([...ACTIONABLE_WORK_ITEM_STATUSES]).toEqual([
      "failed",
      "needs_human",
      "expired",
    ]);
  });

  test("ACTIONABLE_WORK_ITEM_STATUSES leaves out blocked", () => {
    expect(ACTIONABLE_WORK_ITEM_STATUSES).not.toContain("blocked");
  });

  test("INFO_NOTICE_WINDOW_DAYS is seven", () => {
    expect(INFO_NOTICE_WINDOW_DAYS).toBe(7);
  });
});

describe("operations.md notice table", () => {
  test("documents every kind in NOTICE_SEVERITY", async () => {
    const documented = await documentedNoticeKinds();
    expect(
      Object.keys(NOTICE_SEVERITY).filter((kind) => !documented.includes(kind)),
    ).toEqual([]);
  });

  test("documents no kind that NOTICE_SEVERITY lacks", async () => {
    const documented = await documentedNoticeKinds();
    expect(documented.filter((kind) => !(kind in NOTICE_SEVERITY))).toEqual([]);
  });
});

describe("truncateChars", () => {
  test("returns a short text unchanged", () => {
    expect(truncateChars("abc", 5)).toEqual({ text: "abc", truncated: false });
  });

  test("returns a text of exactly the limit unchanged", () => {
    expect(truncateChars("abcde", 5)).toEqual({
      text: "abcde",
      truncated: false,
    });
  });

  test("cuts a longer text to the limit", () => {
    expect(truncateChars("abcdef", 5)).toEqual({
      text: "abcde",
      truncated: true,
    });
  });

  test("counts a surrogate pair as one character", () => {
    expect(truncateChars("a😀b", 2)).toEqual({ text: "a😀", truncated: true });
  });
});

describe("countHiddenCharacters", () => {
  test("counts nothing in ordinary text with newlines and tabs", () => {
    expect(countHiddenCharacters("a\r\nb\tc 日本語")).toBe(0);
  });

  test("counts a zero width space", () => {
    expect(countHiddenCharacters("a\u200Bb")).toBe(1);
  });

  test("counts a tag character", () => {
    expect(countHiddenCharacters("a\u{E0041}b")).toBe(1);
  });

  test("counts a bidirectional override", () => {
    expect(countHiddenCharacters("a\u202Eb")).toBe(1);
  });

  test("counts a variation selector", () => {
    expect(countHiddenCharacters("a\uFE0F\u{E0100}")).toBe(2);
  });

  test("counts a control character other than the line break and tab", () => {
    expect(countHiddenCharacters("a\u0007b")).toBe(1);
  });
});

describe("countHtmlCommentOpeners", () => {
  test("counts nothing without a comment", () => {
    expect(countHtmlCommentOpeners("a <b> c")).toBe(0);
  });

  test("counts each opener", () => {
    expect(countHtmlCommentOpeners("<!-- a --> x <!-- b")).toBe(2);
  });
});
