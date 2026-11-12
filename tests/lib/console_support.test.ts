import { describe, expect, test } from "bun:test";
import {
  NOTICE_KIND_SOURCE,
  noticeDocAnchor,
} from "../../console/src/lib/noticeDocLink.ts";
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

/** `docs/operations.md`の本文。ファイルの読み込みは1回にする。 */
const OPERATIONS_DOC = await Bun.file("docs/operations.md").text();

/** `heading`の行から、`next`に合う次の見出しの前までを返す。 */
function sectionOf(heading: string, next: RegExp): string {
  const start = OPERATIONS_DOC.indexOf(heading);
  const rest = OPERATIONS_DOC.slice(start + 1);
  const end = rest.search(next);
  return end === -1 ? rest : rest.slice(0, end);
}

/** 「通知の種類」の節。次の`##`か`###`の見出しの前までである。 */
const NOTICE_KINDS_SECTION = sectionOf("### 通知の種類", /\n#{2,3} /);

/** 冒頭の「症状から手順を引く」の節。次の`##`の見出しの前までである。 */
const INDEX_SECTION = sectionOf("## 症状から手順を引く", /\n## /);

/** 通知の表の1行。種類の列の先頭にアンカーが無い行は、`anchor`が`null`である。 */
type NoticeTableRow = { readonly anchor: string | null; readonly kind: string };

/** 「通知の種類」の表の、行ごとのアンカーと種類。種類の形はConsoleと同じ`NOTICE_KIND_SOURCE`で読む。 */
const NOTICE_TABLE_ROWS: readonly NoticeTableRow[] = [
  ...NOTICE_KINDS_SECTION.matchAll(
    new RegExp(
      `^\\| (?:<a id="([^"]*)"><\\/a>)?\`(${NOTICE_KIND_SOURCE})\` \\|`,
      "gm",
    ),
  ),
].map((m) => ({ anchor: m[1] ?? null, kind: m[2] ?? "" }));

/** 「通知の種類」の表の、種類の列。 */
const DOCUMENTED_NOTICE_KINDS: readonly string[] = NOTICE_TABLE_ROWS.map(
  (row) => row.kind,
);

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

  test("lists a stale GitHub collection as a known action kind", () => {
    expect(NOTICE_SEVERITY.github_collect_stale).toBe("action");
  });

  test("lists a Claude usage limit as a known action kind", () => {
    expect(NOTICE_SEVERITY.claude_usage_limit).toBe("action");
  });

  test("lists a stale schedule detector as a known action kind", () => {
    expect(NOTICE_SEVERITY.schedule_detector_stale).toBe("action");
  });

  test("lists a failed backup as a known action kind", () => {
    expect(NOTICE_SEVERITY.backup_failed).toBe("action");
  });

  test("treats a merge conflict of a pull request as action", () => {
    expect(noticeSeverity("pr_conflict")).toBe("action");
  });

  test("treats a prolonged gated review mode as action", () => {
    expect(noticeSeverity("review_gated_prolonged")).toBe("action");
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

describe("doc_hash_column_missing", () => {
  test("is listed in the severity table as an action notice", () => {
    expect(NOTICE_SEVERITY.doc_hash_column_missing).toBe("action");
  });

  test("can be resolved from the Console", () => {
    expect(isNoticeResolvable("doc_hash_column_missing")).toBe(true);
  });
});

describe("design_enabled_ignored", () => {
  test("is listed in the severity table as an action notice", () => {
    expect(NOTICE_SEVERITY.design_enabled_ignored).toBe("action");
  });

  test("cannot be resolved from the Console", () => {
    expect(isNoticeResolvable("design_enabled_ignored")).toBe(false);
  });
});

describe("merge hold notices", () => {
  test("the notice that pull requests wait for a hold needs no action", () => {
    expect(noticeSeverity("dependabot_merge_held")).toBe("info");
  });

  test("the notice that the holds cannot be read needs an action", () => {
    expect(noticeSeverity("dependabot_merge_hold_unreadable")).toBe("action");
  });

  test("the notice that the holds cannot be read can be resolved from the Console", () => {
    expect(isNoticeResolvable("dependabot_merge_hold_unreadable")).toBe(true);
  });
});

describe("hold release notices", () => {
  test("the notice that a person released a hold needs no action", () => {
    expect(noticeSeverity("hold_released")).toBe("info");
  });

  test("the notice that a person released a hold can be resolved from the Console", () => {
    expect(isNoticeResolvable("hold_released")).toBe(true);
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

  test("contains the fourteen kinds that need no action", () => {
    expect([...INFO_NOTICE_KINDS].sort()).toEqual([
      "approval_notify_failed",
      "claim_race_lost",
      "cleanup_worktrees_skipped",
      "dependabot_merge_held",
      "deploy_approval_decided",
      "fix_feedback_association_excluded",
      "fork_head_denied",
      "hold_released",
      "implement_needs_human",
      "labeler_denied",
      "stop_all_released",
      "supersede_failed",
      "unsandboxed_check_commands",
      "workspace_disk_usage",
    ]);
  });
});

describe("UNRESOLVABLE_NOTICE_KINDS", () => {
  test("contains the security-related kinds and the ignored design setting, and the stop-all", () => {
    expect([...UNRESOLVABLE_NOTICE_KINDS].sort()).toEqual([
      "deploy_approval_required",
      "design_enabled_ignored",
      "fix_feedback_association_excluded",
      "labeler_denied",
      "stop_all_active",
      "unsandboxed_check_commands",
    ]);
  });

  test("leaves only the self-resolved kinds outside the info kinds", () => {
    expect(
      UNRESOLVABLE_NOTICE_KINDS.filter(
        (kind) => !INFO_NOTICE_KINDS.includes(kind),
      ).sort(),
    ).toEqual([
      "deploy_approval_required",
      "design_enabled_ignored",
      "stop_all_active",
    ]);
  });
});

describe("deploy approval notices", () => {
  test("deploy_approval_required needs an action", () => {
    expect(NOTICE_SEVERITY.deploy_approval_required).toBe("action");
  });

  test("deploy_approval_decided is information", () => {
    expect(NOTICE_SEVERITY.deploy_approval_decided).toBe("info");
  });

  test("the Console cannot resolve deploy_approval_required, which only a decision or a deployment resolves", () => {
    expect(isNoticeResolvable("deploy_approval_required")).toBe(false);
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
  test("documents every kind in NOTICE_SEVERITY", () => {
    expect(
      Object.keys(NOTICE_SEVERITY).filter(
        (kind) => !DOCUMENTED_NOTICE_KINDS.includes(kind),
      ),
    ).toEqual([]);
  });

  test("documents doc_hash_column_missing", () => {
    expect(DOCUMENTED_NOTICE_KINDS).toContain("doc_hash_column_missing");
  });

  test("documents design_enabled_ignored", () => {
    expect(DOCUMENTED_NOTICE_KINDS).toContain("design_enabled_ignored");
  });

  test("documents claude_usage_limit", () => {
    expect(DOCUMENTED_NOTICE_KINDS).toContain("claude_usage_limit");
  });

  test("documents no kind that NOTICE_SEVERITY lacks", () => {
    expect(
      DOCUMENTED_NOTICE_KINDS.filter((kind) => !(kind in NOTICE_SEVERITY)),
    ).toEqual([]);
  });
});

/** 索引の表の、バッククォートで名指しした種類の形の語。 */
const INDEX_NAMED_KINDS: readonly string[] = [
  ...INDEX_SECTION.matchAll(new RegExp(`\`(${NOTICE_KIND_SOURCE})\``, "g")),
].map((m) => m[1] ?? "");

describe("operations.md symptom index", () => {
  test("names some notice kinds", () => {
    expect(INDEX_NAMED_KINDS.length).toBeGreaterThan(0);
  });

  test("names only kinds in NOTICE_SEVERITY", () => {
    expect(
      INDEX_NAMED_KINDS.filter((kind) => !(kind in NOTICE_SEVERITY)),
    ).toEqual([]);
  });
});

// Consoleの通知の詳細は、種類から`docs/operations.md#notice-<種類>`を決めてリンクする。
// 表のアンカーは`notice-<種類>`の名前で確かめ、Consoleの規則(`noticeDocAnchor`)が同じ名前を作ることを先頭のテストで確かめる。
describe("operations.md notice anchors", () => {
  test("names the Console anchor of every kind in NOTICE_SEVERITY after the kind as it is", () => {
    expect(
      Object.keys(NOTICE_SEVERITY).filter(
        (kind) => noticeDocAnchor(kind) !== `notice-${kind}`,
      ),
    ).toEqual([]);
  });

  test("has the anchor of every kind in NOTICE_SEVERITY", () => {
    const anchors = NOTICE_TABLE_ROWS.map((row) => row.anchor);
    expect(
      Object.keys(NOTICE_SEVERITY).filter(
        (kind) => !anchors.includes(`notice-${kind}`),
      ),
    ).toEqual([]);
  });

  test("puts each anchor in the row of its own kind", () => {
    expect(
      NOTICE_TABLE_ROWS.filter((row) => row.anchor !== `notice-${row.kind}`),
    ).toEqual([]);
  });

  test("has as many anchors in the section as there are kinds", () => {
    expect([...NOTICE_KINDS_SECTION.matchAll(/<a id="/g)].length).toBe(
      Object.keys(NOTICE_SEVERITY).length,
    );
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
