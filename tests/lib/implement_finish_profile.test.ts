// 承認を省く進め方(仕様がIssue)の実装の完了処理が使う、純粋な判定と文面を固定する。
// 完了のステップ本体の結線は`tests/scripts/implement_finish_profile.test.ts`が固定する。

import { describe, expect, test } from "bun:test";
import {
  decideProtectedPathReroute,
  PROTECTED_PATH_GAP_PREFIX,
  PROTECTED_WORK_NOT_PUSHED_REASON,
  prBodySpecFor,
  shouldWithholdPartialPush,
} from "../../f/factory/lib/implement_finish_support.ts";
import {
  buildProfileUpgradedComment,
  PROFILE_UPGRADED_COMMENT_KIND,
  postProfileUpgradedComment,
  shouldCommentProfileUpgrade,
} from "../../f/factory/lib/profile_upgrade.ts";
import {
  describeReason,
  nextActionFor,
} from "../../f/factory/steps/pr_workflow_support.ts";

const CONSOLE_URL =
  "http://127.0.0.1:8080/console/items/3/requirements?attempt=2";

describe("prBodySpecFor", () => {
  test("hands the profile of a context whose specification is the issue", () => {
    expect(
      prBodySpecFor({
        spec_kind: "issue",
        profile: "docs",
        requirements_markdown: null,
        requirements_console_url: null,
      }),
    ).toEqual({ kind: "issue", profile: "docs" });
  });

  test("hands the markdown and the link of a context whose specification is the requirements", () => {
    expect(
      prBodySpecFor({
        spec_kind: "requirements",
        profile: "standard",
        requirements_markdown: "# 要件定義",
        requirements_console_url: CONSOLE_URL,
      }),
    ).toEqual({
      kind: "requirements",
      requirementsMarkdown: "# 要件定義",
      requirementsConsoleUrl: CONSOLE_URL,
    });
  });

  test("reads a context made before the field existed as the requirements", () => {
    expect(
      prBodySpecFor({
        requirements_markdown: "# 要件定義",
        requirements_console_url: CONSOLE_URL,
      }).kind,
    ).toBe("requirements");
  });
});

describe("decideProtectedPathReroute", () => {
  const CHANGES = [
    "保護パスを変更: .github/workflows/ci.yml",
    "package.jsonのscriptsを変更",
  ];

  test("does not send a change of the approved requirements back", () => {
    expect(
      decideProtectedPathReroute({
        specKind: "requirements",
        protectedChanges: CHANGES,
      }),
    ).toBeNull();
  });

  test("does not send a diff without a protected change back", () => {
    expect(
      decideProtectedPathReroute({ specKind: "issue", protectedChanges: [] }),
    ).toBeNull();
  });

  test("sends a protected change of the issue specification back with a report", () => {
    expect(
      decideProtectedPathReroute({
        specKind: "issue",
        protectedChanges: CHANGES,
      })?.gapReport.startsWith(PROTECTED_PATH_GAP_PREFIX),
    ).toBe(true);
  });

  test("lists the first protected change in the report", () => {
    expect(
      decideProtectedPathReroute({
        specKind: "issue",
        protectedChanges: CHANGES,
      })?.gapReport,
    ).toContain("保護パスを変更: .github/workflows/ci.yml");
  });

  test("lists the last protected change in the report", () => {
    expect(
      decideProtectedPathReroute({
        specKind: "issue",
        protectedChanges: CHANGES,
      })?.gapReport,
    ).toContain("package.jsonのscriptsを変更");
  });

  test("states that the change needs a protected path", () => {
    expect(PROTECTED_PATH_GAP_PREFIX).toBe("保護パスの変更が要る: ");
  });
});

describe("shouldWithholdPartialPush", () => {
  test("withholds the partial work of the issue specification that touches a protected path", () => {
    expect(
      shouldWithholdPartialPush({
        specKind: "issue",
        protectedChanges: ["保護パスを変更: mise.toml"],
      }),
    ).toBe(true);
  });

  test("keeps pushing the partial work of the issue specification without a protected change", () => {
    expect(
      shouldWithholdPartialPush({ specKind: "issue", protectedChanges: [] }),
    ).toBe(false);
  });

  test("keeps pushing the partial work of the approved requirements", () => {
    expect(
      shouldWithholdPartialPush({
        specKind: "requirements",
        protectedChanges: ["保護パスを変更: mise.toml"],
      }),
    ).toBe(false);
  });

  test("words the reason in English for the note of the stop", () => {
    expect(PROTECTED_WORK_NOT_PUSHED_REASON).toBe(
      "protected path changes without approved requirements, changes not pushed",
    );
  });

  test("describes the reason in Japanese", () => {
    expect(describeReason(PROTECTED_WORK_NOT_PUSHED_REASON)).toContain(
      "保護パス",
    );
  });

  test("points the next action at the worktree", () => {
    expect(
      nextActionFor(PROTECTED_WORK_NOT_PUSHED_REASON, "implement"),
    ).toContain("worktree");
  });
});

describe("shouldCommentProfileUpgrade", () => {
  test("does not comment when the profile was already standard", () => {
    expect(shouldCommentProfileUpgrade("standard")).toBe(false);
  });

  test.each(["direct", "bugfix", "docs", "unknown"])(
    "comments when the profile was %s",
    (profile) => {
      expect(shouldCommentProfileUpgrade(profile)).toBe(true);
    },
  );
});

describe("buildProfileUpgradedComment", () => {
  const BASE = {
    workItemId: 31,
    previousProfile: "direct",
    cause: "requirements_gap" as const,
  };

  test("names the work item", () => {
    expect(buildProfileUpgradedComment(BASE)).toContain("work_item_id: 31");
  });

  test("names the profile before the switch", () => {
    expect(buildProfileUpgradedComment(BASE)).toContain("direct");
  });

  test("says that the requirements were short", () => {
    expect(buildProfileUpgradedComment(BASE)).toContain("要件が足りない");
  });

  test("says that a protected path was needed", () => {
    expect(
      buildProfileUpgradedComment({ ...BASE, cause: "protected_paths" }),
    ).toContain("保護パスの変更が要る");
  });

  test("says that an approval is asked for", () => {
    expect(buildProfileUpgradedComment(BASE)).toContain("承認を依頼します");
  });
});

describe("postProfileUpgradedComment", () => {
  type Posted = { kind: string; body: string };

  function setup(fail = false) {
    const posted: Posted[] = [];
    const warnings: string[] = [];
    return {
      posted,
      warnings,
      deps: {
        comment: async (kind: string, body: string) => {
          if (fail) throw new Error("boom");
          posted.push({ kind, body });
        },
        warn: (message: string) => {
          warnings.push(message);
        },
      },
    };
  }

  const INPUT = {
    previousProfile: "bugfix",
    workItemId: 31,
    cause: "requirements_gap" as const,
  };

  test("posts the comment of the switch for a profile that was not standard", async () => {
    const { posted, deps } = setup();
    await postProfileUpgradedComment(INPUT, deps);
    expect(posted).toEqual([
      {
        kind: PROFILE_UPGRADED_COMMENT_KIND,
        body: buildProfileUpgradedComment(INPUT),
      },
    ]);
  });

  test("returns posted after posting", async () => {
    const { deps } = setup();
    expect(await postProfileUpgradedComment(INPUT, deps)).toBe("posted");
  });

  test("posts nothing for a profile that was already standard", async () => {
    const { posted, deps } = setup();
    await postProfileUpgradedComment(
      { ...INPUT, previousProfile: "standard" },
      deps,
    );
    expect(posted).toEqual([]);
  });

  test("returns skipped for a profile that was already standard", async () => {
    const { deps } = setup();
    expect(
      await postProfileUpgradedComment(
        { ...INPUT, previousProfile: "standard" },
        deps,
      ),
    ).toBe("skipped");
  });

  test("does not throw when the comment fails", async () => {
    const { deps } = setup(true);
    expect(await postProfileUpgradedComment(INPUT, deps)).toBe("failed");
  });

  test("warns when the comment fails", async () => {
    const { warnings, deps } = setup(true);
    await postProfileUpgradedComment(INPUT, deps);
    expect(warnings).toEqual([
      "the profile upgrade comment could not be posted",
    ]);
  });

  test("keeps the kind of the marker fixed", () => {
    expect(PROFILE_UPGRADED_COMMENT_KIND).toBe("profile-upgraded");
  });
});
