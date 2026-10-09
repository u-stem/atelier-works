import { describe, expect, test } from "bun:test";
import {
  ACTIONABLE_WORK_ITEM_STATUSES,
  INFO_NOTICE_KINDS,
  INFO_NOTICE_WINDOW_DAYS,
  isNoticeResolvable,
  NOTICE_SEVERITY,
  noticeSeverity,
  UNRESOLVABLE_NOTICE_KINDS,
} from "../../f/factory/lib/console_support.ts";

/** `docs/operations.md`の「Consoleの通知タブ」の表から、種類の列を取り出す。 */
async function documentedNoticeKinds(): Promise<string[]> {
  const doc = await Bun.file("docs/operations.md").text();
  const start = doc.indexOf("### Consoleの通知タブ");
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

describe("INFO_NOTICE_KINDS", () => {
  test("lists exactly the kinds whose severity is info", () => {
    expect([...INFO_NOTICE_KINDS].sort()).toEqual(
      Object.entries(NOTICE_SEVERITY)
        .filter(([, severity]) => severity === "info")
        .map(([kind]) => kind)
        .sort(),
    );
  });

  test("contains the eight kinds that need no action", () => {
    expect([...INFO_NOTICE_KINDS].sort()).toEqual([
      "approval_notify_failed",
      "claim_race_lost",
      "cleanup_worktrees_skipped",
      "fix_feedback_association_excluded",
      "labeler_association_denied",
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
      "labeler_association_denied",
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
  test("ACTIONABLE_WORK_ITEM_STATUSES is failed and needs_human", () => {
    expect([...ACTIONABLE_WORK_ITEM_STATUSES]).toEqual([
      "failed",
      "needs_human",
    ]);
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
