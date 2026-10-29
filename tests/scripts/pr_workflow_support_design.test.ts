// 設計工程が`needs_human`にする理由を、通知が日本語で訳し、次の操作を案内することを確かめる。

import { describe, expect, test } from "bun:test";
import {
  DESIGN_APPROVAL_INCONSISTENT_REASON,
  DESIGN_STALE_REQUIREMENTS_REASON,
  designGateReason,
  noApprovedDesignReason,
} from "../../f/factory/lib/approval_gate.ts";
import { DESIGN_START_FAILED_REASON } from "../../f/factory/lib/design_launch_support.ts";
import {
  DESIGN_APPROVAL_TIMED_OUT_REASON,
  DESIGN_DOC_DIR_IN_USE_REASON,
  DESIGN_REJECTED_EXHAUSTED_PREFIX,
  DESIGN_STAGE_CLOSED_REASON,
  designGapExhaustedReason,
  designNoApprovalReason,
  designRejectedExhaustedReason,
} from "../../f/factory/lib/design_template.ts";
import {
  REQUIREMENTS_DIR_MISSING_REASON,
  REQUIREMENTS_MODIFIED_BEFORE_DESIGN_REASON,
  REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON,
  REQUIREMENTS_MODIFIED_REASON,
} from "../../f/factory/lib/doc_tree_hash.ts";
import {
  DESIGN_GAP_DISABLED_REASON,
  DESIGN_GAP_EXHAUSTED_REASON,
} from "../../f/factory/lib/implement_finish_support.ts";
import {
  describeReason,
  designGapNewerCycleReason,
  designGapParentMovedReason,
  designGapRerouteRaceLostReason,
  designNeedsHumanFields,
  evaluateDesignGapRerouteParentStatus,
  nextActionFor,
  nextActionForPrFix,
  PR_FIX_DESIGN_GAP_DISABLED_REASON,
  PR_FIX_DESIGN_GAP_EXHAUSTED_REASON,
  PR_FIX_DESIGN_GAP_PARENT_MISSING_REASON,
  PR_FIX_DESIGN_STAGE_PARENT_REASON,
  REVIEW_DESIGN_STAGE_REASON,
  shouldAdvanceWatermarks,
  withGapReport,
} from "../../f/factory/steps/pr_workflow_support.ts";

const RETRY = "f/factory/retry_work_item";
const RELABEL = "`factory`ラベルを付け直";

describe("describeReason for the design stage", () => {
  test("translates a design flow that could not be started", () => {
    expect(describeReason(DESIGN_START_FAILED_REASON)).toBe(
      "設計フローを起動できませんでした",
    );
  });

  test("translates a design flow that could not be started with a detail", () => {
    expect(
      describeReason("design flow could not be started: runFlowAsync failed"),
    ).toBe("設計フローを起動できませんでした(runFlowAsync failed)");
  });

  test("translates a missing approval for the attempt", () => {
    expect(describeReason(designNoApprovalReason(2))).toContain(
      "承認済みの要件定義が無い",
    );
  });

  test("names the attempt that has no approval", () => {
    expect(describeReason(designNoApprovalReason(2))).toContain("2");
  });

  test("translates a requirements gap after max_attempts", () => {
    expect(describeReason(designGapExhaustedReason(3))).toBe(
      "設計が要件の不足を報告しましたが、要件定義の試行回数が上限(3)に達しました",
    );
  });

  test("translates a change before design", () => {
    expect(
      describeReason(REQUIREMENTS_MODIFIED_BEFORE_DESIGN_REASON),
    ).toContain("設計を始める前");
  });

  test("translates a change during design", () => {
    expect(describeReason(REQUIREMENTS_MODIFIED_REASON)).toContain(
      "設計の実行中",
    );
  });

  test("translates a change before implementation", () => {
    expect(
      describeReason(REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON),
    ).toContain("実装");
  });

  test("translates a missing requirements directory apart from a change", () => {
    expect(describeReason(REQUIREMENTS_DIR_MISSING_REASON)).toContain(
      "ディレクトリがありません",
    );
  });

  test("translates a rejection that arrives while the design stage is closed", () => {
    expect(describeReason(DESIGN_STAGE_CLOSED_REASON)).toContain("設計工程");
  });

  test("translates a design directory that already holds a draft", () => {
    expect(describeReason(DESIGN_DOC_DIR_IN_USE_REASON)).toContain("下書き");
  });

  test("translates a missing design approval for the attempt", () => {
    expect(describeReason(noApprovedDesignReason(2))).toBe(
      "設計の試行2回目に承認済みの設計書が無いため、実装を始められませんでした",
    );
  });

  test("translates a design that does not match the approved requirements", () => {
    expect(describeReason(DESIGN_STALE_REQUIREMENTS_REASON)).toBe(
      "承認済みの設計書が、承認済みの要件定義と食い違っています",
    );
  });

  test("translates an inconsistent design approval record", () => {
    expect(describeReason(DESIGN_APPROVAL_INCONSISTENT_REASON)).toBe(
      "設計の承認の記録が、設計書と食い違っています",
    );
  });
});

describe("nextActionFor for the design stage", () => {
  test("tells how to retry a design flow that could not be started", () => {
    expect(nextActionFor(DESIGN_START_FAILED_REASON, "design")).toContain(
      RETRY,
    );
  });

  test("tells to check the approval when the attempt has none", () => {
    expect(nextActionFor(designNoApprovalReason(2))).toContain("承認");
  });

  test("tells a person to tidy the requirements after the attempts ran out", () => {
    expect(nextActionFor(designGapExhaustedReason(3))).toContain("Issueに追記");
  });

  test.each([
    ["before design", REQUIREMENTS_MODIFIED_BEFORE_DESIGN_REASON],
    ["during design", REQUIREMENTS_MODIFIED_REASON],
    ["before implementation", REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON],
    ["a missing directory", REQUIREMENTS_DIR_MISSING_REASON],
  ])(
    "tells to check the directory before the retry for %s",
    (_name, reason) => {
      expect(nextActionFor(reason)).toStartWith(
        "承認済みの要件定義のディレクトリを確かめてから、",
      );
    },
  );

  test.each([
    ["before design", REQUIREMENTS_MODIFIED_BEFORE_DESIGN_REASON],
    ["during design", REQUIREMENTS_MODIFIED_REASON],
    ["before implementation", REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON],
    ["a missing directory", REQUIREMENTS_DIR_MISSING_REASON],
  ])("tells to retry the work item for %s", (_name, reason) => {
    expect(nextActionFor(reason)).toContain(RETRY);
  });

  test.each([
    ["before design", REQUIREMENTS_MODIFIED_BEFORE_DESIGN_REASON],
    ["during design", REQUIREMENTS_MODIFIED_REASON],
    ["before implementation", REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON],
    ["a missing directory", REQUIREMENTS_DIR_MISSING_REASON],
  ])(
    "tells that the retry makes the requirements again for %s",
    (_name, reason) => {
      expect(nextActionFor(reason)).toContain(
        "(要件定義を作り直すので、承認し直しが要ります)",
      );
    },
  );

  test.each([
    ["before design", REQUIREMENTS_MODIFIED_BEFORE_DESIGN_REASON],
    ["during design", REQUIREMENTS_MODIFIED_REASON],
    ["before implementation", REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON],
    ["a missing directory", REQUIREMENTS_DIR_MISSING_REASON],
  ])(
    "does not say the retry stops for the same reason for %s",
    (_name, reason) => {
      expect(nextActionFor(reason)).not.toContain("同じ理由で止まります");
    },
  );

  test.each([
    ["before design", REQUIREMENTS_MODIFIED_BEFORE_DESIGN_REASON],
    ["during design", REQUIREMENTS_MODIFIED_REASON],
    ["before implementation", REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON],
    ["a missing directory", REQUIREMENTS_DIR_MISSING_REASON],
  ])("does not tell to relabel the Issue for %s", (_name, reason) => {
    expect(nextActionFor(reason)).not.toContain(RELABEL);
  });

  test("tells to check the setting of the design stage when it is closed", () => {
    expect(nextActionFor(DESIGN_STAGE_CLOSED_REASON)).toContain(
      "設計工程の設定を確かめ",
    );
  });

  test("tells how to retry when the design stage is closed", () => {
    expect(nextActionFor(DESIGN_STAGE_CLOSED_REASON)).toContain(RETRY);
  });

  test("tells how to retry a design directory that already holds a draft", () => {
    expect(nextActionFor(DESIGN_DOC_DIR_IN_USE_REASON)).toContain(RETRY);
  });

  test.each([
    ["a missing design approval", noApprovedDesignReason(2)],
    ["a stale design", DESIGN_STALE_REQUIREMENTS_REASON],
  ])(
    "tells to retry from the design when it is enabled for %s",
    (_name, reason) => {
      expect(nextActionFor(reason)).toContain(
        `${RETRY}\`を作業項目のIDで実行してください(設計が有効なら設計から再開します)`,
      );
    },
  );

  test("tells to check the approval record before the retry of an inconsistent design approval", () => {
    expect(nextActionFor(DESIGN_APPROVAL_INCONSISTENT_REASON)).toContain(
      "承認の記録を確かめ",
    );
  });

  test("tells how to retry an inconsistent design approval", () => {
    expect(nextActionFor(DESIGN_APPROVAL_INCONSISTENT_REASON)).toContain(RETRY);
  });

  test("tells how to retry when a process the design run left holds the worktree lock", () => {
    expect(
      nextActionFor(
        "worktree lock is held by a process this run left behind",
        "design",
      ),
    ).toContain(RETRY);
  });

  test("mentions the design run when it names the process it left", () => {
    expect(
      nextActionFor(
        "worktree lock is held by a process this run left behind",
        "design",
      ),
    ).toContain("設計");
  });

  test("tells how to retry when processes from an earlier run still use the worktree", () => {
    expect(
      nextActionFor(
        "worktree is still used by processes from an earlier run: pid 1",
        "design",
      ),
    ).toContain(RETRY);
  });
});

// この表は設計の定数をimportしない。importするとpr_workflow_support.tsの依存が増えるため、理由の文字列を直接書く。
// 生成する側の関数と定数の出力を表と突き合わせて、食い違いを検出する。
describe("the reason table and the reasons that the design stage produces", () => {
  /** 生成する側の識別子と、その理由の例。新しい理由を足したら、ここと表の両方に載せる。 */
  const PRODUCED: Record<string, string> = {
    DESIGN_START_FAILED_REASON,
    designNoApprovalReason: designNoApprovalReason(2),
    designGapExhaustedReason: designGapExhaustedReason(3),
    REQUIREMENTS_MODIFIED_BEFORE_DESIGN_REASON,
    REQUIREMENTS_MODIFIED_REASON,
    REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON,
    REQUIREMENTS_DIR_MISSING_REASON,
    DESIGN_DOC_DIR_IN_USE_REASON,
    noApprovedDesignReason: noApprovedDesignReason(2),
    designGateReason: designGateReason({ kind: "inconsistent" }, 1),
    DESIGN_STALE_REQUIREMENTS_REASON,
    DESIGN_APPROVAL_INCONSISTENT_REASON,
    DESIGN_APPROVAL_TIMED_OUT_REASON,
    DESIGN_STAGE_CLOSED_REASON,
    designRejectedExhaustedReason: designRejectedExhaustedReason(3),
    DESIGN_GAP_EXHAUSTED_REASON,
    DESIGN_GAP_DISABLED_REASON,
  };

  /** 設計の理由の定数を持つファイル。 */
  const CONSTANT_SOURCES = [
    "approval_gate.ts",
    "design_launch_support.ts",
    "design_template.ts",
    "doc_tree_hash.ts",
  ];
  // 理由を返す関数は、設計の定数の置き場の2つだけを数える。
  // design_launch_supportの関数が返すのは、起動の失敗の詳細であり、`needs_human`の理由ではない。
  // `is`で始まる名前は、注記が理由かを判定する述語で、理由の文字列を返さないので数えない。
  const FUNCTION_SOURCES = [
    "approval_gate.ts",
    "design_template.ts",
    "doc_tree_hash.ts",
  ];

  async function exportedNames(
    files: string[],
    pattern: RegExp,
  ): Promise<string[]> {
    const names: string[] = [];
    for (const file of files) {
      const text = await Bun.file(
        new URL(`../../f/factory/lib/${file}`, import.meta.url),
      ).text();
      for (const match of text.matchAll(pattern)) {
        const name = match[1];
        if (name !== undefined) names.push(name);
      }
    }
    return names;
  }

  test("lists every exported reason constant of the design stage", async () => {
    const constants = await exportedNames(
      CONSTANT_SOURCES,
      /^export const ([A-Z_]+_REASON)\b/gm,
    );
    expect(constants.filter((name) => !(name in PRODUCED))).toEqual([]);
  });

  test("lists every exported function that returns a reason of the design stage", async () => {
    const functions = await exportedNames(
      FUNCTION_SOURCES,
      /^export function (?!is[A-Z])(\w+Reason)\(/gm,
    );
    expect(functions.filter((name) => !(name in PRODUCED))).toEqual([]);
  });

  test("finds the exported reasons in the sources", async () => {
    const constants = await exportedNames(
      CONSTANT_SOURCES,
      /^export const ([A-Z_]+_REASON)\b/gm,
    );
    expect(constants.length).toBeGreaterThanOrEqual(8);
  });

  test("finds the exported reason functions in the sources", async () => {
    const functions = await exportedNames(
      FUNCTION_SOURCES,
      /^export function (?!is[A-Z])(\w+Reason)\(/gm,
    );
    expect(functions.length).toBeGreaterThanOrEqual(4);
  });

  test.each(Object.entries(PRODUCED))(
    "translates the reason of %s",
    (_name, reason) => {
      expect(describeReason(reason)).not.toBe(reason);
    },
  );

  // 起動の失敗の案内は、ほかの失敗と同じ一般の手順なので、固有の案内の突き合わせから外す。
  const WITH_OWN_ACTION = Object.entries(PRODUCED).filter(
    ([name]) => name !== "DESIGN_START_FAILED_REASON",
  );

  test.each(WITH_OWN_ACTION)(
    "guides the next action of %s",
    (_name, reason) => {
      expect(nextActionFor(reason, "design")).not.toBe(
        nextActionFor("a reason that no rule describes", "design"),
      );
    },
  );
});

describe("the reason of a design approval that timed out", () => {
  test("is the fixed sentence of the timeout", () => {
    expect(DESIGN_APPROVAL_TIMED_OUT_REASON).toBe("design approval timed out");
  });

  test("translates the timeout", () => {
    expect(describeReason(DESIGN_APPROVAL_TIMED_OUT_REASON)).toBe(
      "設計の承認がタイムアウトしました",
    );
  });

  test("tells how to retry after the timeout", () => {
    expect(nextActionFor(DESIGN_APPROVAL_TIMED_OUT_REASON)).toContain(RETRY);
  });

  test("tells that the design is regenerated with the approved requirements", () => {
    expect(nextActionFor(DESIGN_APPROVAL_TIMED_OUT_REASON)).toContain(
      "設計書を作り直します。承認済みの要件定義は使います",
    );
  });

  test("tells that an approval recorded after the timeout starts the implementation", () => {
    expect(nextActionFor(DESIGN_APPROVAL_TIMED_OUT_REASON)).toContain(
      "最新の依頼が承認済みなら実装から始めます",
    );
  });

  test("does not tell the operator to decide a request that expired", () => {
    expect(nextActionFor(DESIGN_APPROVAL_TIMED_OUT_REASON)).not.toContain(
      "承認または却下してください",
    );
  });
});

describe("the reason of a design that was rejected up to the limit", () => {
  test("names the limit", () => {
    expect(designRejectedExhaustedReason(3)).toBe(
      "design rejected after max_design_attempts 3",
    );
  });

  test("starts with the prefix that counts the applied rejections", () => {
    expect(
      designRejectedExhaustedReason(3).startsWith(
        DESIGN_REJECTED_EXHAUSTED_PREFIX,
      ),
    ).toBe(true);
  });

  test("translates the limit", () => {
    expect(describeReason(designRejectedExhaustedReason(3))).toBe(
      "設計の却下と実装からの戻しが上限(max_design_attemptsの3回)に達しました",
    );
  });

  test("tells how to retry after the limit", () => {
    expect(nextActionFor(designRejectedExhaustedReason(3))).toContain(RETRY);
  });

  test("tells that the reason of the rejection is passed on", () => {
    expect(nextActionFor(designRejectedExhaustedReason(3))).toContain(
      "直前の却下の理由を渡します",
    );
  });

  test("tells that each retry tries the design once", () => {
    expect(nextActionFor(designRejectedExhaustedReason(3))).toContain(
      "再実行ごとに設計を1回試します",
    );
  });

  test("does not say that the rejections were consecutive", () => {
    expect(describeReason(designRejectedExhaustedReason(3))).not.toContain(
      "連続",
    );
  });
});

describe("the retry note of a requirements regeneration that a design rejection could not start", () => {
  const REASON = "requirements regeneration could not be started";

  test("tells that the reason of the rejection is passed to the regeneration", () => {
    expect(nextActionFor(REASON, "design_rejection")).toContain(
      "却下の理由は再実行で要件定義の生成に渡ります",
    );
  });

  test("tells that the intake is updated with the current issue", () => {
    expect(nextActionFor(REASON, "design_rejection")).toContain(
      "取り込み内容は現在のIssueで更新されます",
    );
  });

  test("tells that the requirements need a new approval", () => {
    expect(nextActionFor(REASON, "design_rejection")).toContain(
      "承認し直しが要ります",
    );
  });

  test("keeps the note of the rejection of requirements", () => {
    expect(nextActionFor(REASON)).toBe(
      "Windmillで`f/factory/retry_work_item`を作業項目のIDで実行してください(要件定義を作り直します。承認し直しが要ります。却下の理由は再実行で要件定義の生成に渡ります)",
    );
  });

  test("keeps the note of the design flow", () => {
    expect(nextActionFor(REASON, "design")).toContain(
      "作業項目の履歴の注記に残っていて",
    );
  });

  test("keeps the note of the implement flow", () => {
    expect(nextActionFor(REASON, "implement")).toContain("通知に残っていて");
  });
});

describe("designNeedsHumanFields", () => {
  const LOCK_HELD = "worktree lock is held by a process this run left behind";

  test("translates the reason", () => {
    expect(designNeedsHumanFields(designNoApprovalReason(2)).reason).toBe(
      describeReason(designNoApprovalReason(2)),
    );
  });

  test("guides the next action of the design flow", () => {
    expect(designNeedsHumanFields(LOCK_HELD).next_action).toBe(
      nextActionFor(LOCK_HELD, "design"),
    );
  });

  test("does not tell a design run to rerun the checks of the implement flow", () => {
    expect(designNeedsHumanFields(LOCK_HELD).next_action).not.toContain(
      "検査コマンド",
    );
  });
});

// 通知の組み立てはWindmillの入出力を含むmainの中にあるので、結線はソースの文面で固定する。
describe("the wiring of the design notifications", () => {
  /** コメントを除いたソース。コメントに書いた文字列を、結線として数えないため。 */
  async function stepSource(name: string): Promise<string> {
    const text = await Bun.file(
      new URL(`../../f/factory/steps/${name}`, import.meta.url),
    ).text();
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  }

  test.each(["design_generate.ts", "design_prepare.ts"])(
    "%s builds the reason and next action through the design flow",
    async (name) => {
      expect(await stepSource(name)).toMatch(
        /\.\.\.designNeedsHumanFields\(reason\)/,
      );
    },
  );

  test.each(["design_generate.ts", "design_prepare.ts"])(
    "%s does not write next_action over the one of the design flow",
    async (name) => {
      expect(await stepSource(name)).not.toMatch(/next_action\s*:/);
    },
  );
});

describe("the reason of a design gap that the implementation reported", () => {
  test("translates the limit", () => {
    expect(describeReason(DESIGN_GAP_EXHAUSTED_REASON)).toBe(
      "実装が設計書の不足を報告しましたが、設計の却下と実装からの戻しが上限(max_design_attempts)に達しました",
    );
  });

  test("tells that a retry builds the design again", () => {
    expect(nextActionFor(DESIGN_GAP_EXHAUSTED_REASON, "implement")).toContain(
      "再実行すると設計を作り直します",
    );
  });

  test("tells how to retry after the limit", () => {
    expect(nextActionFor(DESIGN_GAP_EXHAUSTED_REASON, "implement")).toContain(
      RETRY,
    );
  });

  test("translates the closed stage", () => {
    expect(describeReason(DESIGN_GAP_DISABLED_REASON)).toBe(
      "実装が設計書の不足を報告しましたが、設計工程が無効のため、設計へ戻せませんでした",
    );
  });

  test("tells to turn the design stage on first", () => {
    expect(nextActionFor(DESIGN_GAP_DISABLED_REASON, "implement")).toContain(
      "設計工程を有効にしてから",
    );
  });

  test("tells to retry once the stage is on", () => {
    expect(nextActionFor(DESIGN_GAP_DISABLED_REASON, "implement")).toContain(
      RETRY,
    );
  });

  test("tells to start a new cycle by the trigger label", () => {
    expect(nextActionFor(DESIGN_GAP_DISABLED_REASON, "implement")).toContain(
      `${RELABEL}`,
    );
  });
});

describe("the reasons of a design gap that the PR fix reported", () => {
  const PARENT = { id: 7, issue_number: 12 };
  const NEW_CYCLE_ACTION =
    "Issueに`factory`ラベルを付け直して新しいサイクルを始めるか、PRを人が直してください";

  test("translates the limit", () => {
    expect(describeReason(PR_FIX_DESIGN_GAP_EXHAUSTED_REASON)).toBe(
      "PRの修正が設計書の不足を報告しましたが、設計の却下と戻しが上限(max_design_attempts)に達しました",
    );
  });

  test("translates the closed stage", () => {
    expect(describeReason(PR_FIX_DESIGN_GAP_DISABLED_REASON)).toBe(
      "PRの修正が設計書の不足を報告しましたが、設計工程が無効のため、設計へ戻せませんでした",
    );
  });

  test.each([
    ["the limit", PR_FIX_DESIGN_GAP_EXHAUSTED_REASON],
    ["the closed stage", PR_FIX_DESIGN_GAP_DISABLED_REASON],
  ])(
    "tells to start a new cycle or to fix the PR by hand after %s",
    (_name, reason) => {
      expect(nextActionFor(reason, "pr_fix")).toBe(NEW_CYCLE_ACTION);
    },
  );

  test.each([
    ["the limit", PR_FIX_DESIGN_GAP_EXHAUSTED_REASON],
    ["the closed stage", PR_FIX_DESIGN_GAP_DISABLED_REASON],
  ])(
    "does not tell to build the design again by a retry after %s",
    (_name, reason) => {
      expect(nextActionFor(reason, "pr_fix")).not.toContain(RETRY);
    },
  );

  test("does not name the setting of the design stage in the reason of the limit", () => {
    expect(PR_FIX_DESIGN_GAP_EXHAUSTED_REASON).not.toContain("design_enabled");
  });

  test("does not name the setting of the design stage in the reason of the closed stage", () => {
    expect(PR_FIX_DESIGN_GAP_DISABLED_REASON).not.toContain("design_enabled");
  });

  test("translates a parent in the design stage", () => {
    expect(
      describeReason(
        evaluateDesignGapRerouteParentStatus({
          ...PARENT,
          status: "designing",
          flow_job_id: null,
        }) ?? "",
      ),
    ).toBe(
      "親Issue #12(作業項目7)が設計の段階にあるため、設計への差し戻しを止めました",
    );
  });

  test("translates a parent that is being implemented", () => {
    expect(
      describeReason(
        evaluateDesignGapRerouteParentStatus({
          ...PARENT,
          status: "implementing",
          flow_job_id: null,
        }) ?? "",
      ),
    ).toBe(
      "親Issue #12(作業項目7)が実装中のため、設計への差し戻しを止めました",
    );
  });

  test("translates a parent in another status", () => {
    expect(
      describeReason(
        evaluateDesignGapRerouteParentStatus({
          ...PARENT,
          status: "needs_human",
          flow_job_id: null,
        }) ?? "",
      ),
    ).toBe(
      "親Issue #12(作業項目7)の状態がneeds_humanのため、設計への差し戻しを止めました",
    );
  });

  test("translates a parent that a newer cycle replaced", () => {
    expect(describeReason(designGapNewerCycleReason(PARENT))).toBe(
      "親Issue #12(作業項目7)は新しいサイクルに置き換わっているため、設計への差し戻しを止めました",
    );
  });

  test("translates a parent that moved after the fix started", () => {
    expect(describeReason(designGapParentMovedReason(PARENT))).toBe(
      "このPRの修正を始めた後に親Issue #12(作業項目7)が動いたため、設計への差し戻しを止めました",
    );
  });

  test("translates the race that was lost", () => {
    expect(describeReason(designGapRerouteRaceLostReason(PARENT))).toBe(
      "差し戻す前に親Issue #12(作業項目7)の状態が変わったため、設計への差し戻しを止めました",
    );
  });

  test("translates a parent that was not found", () => {
    expect(describeReason(PR_FIX_DESIGN_GAP_PARENT_MISSING_REASON)).toBe(
      "設計への差し戻し先の親の作業項目が見つかりませんでした",
    );
  });

  test("tells to relabel after the design stage of the parent", () => {
    expect(
      nextActionFor(
        evaluateDesignGapRerouteParentStatus({
          ...PARENT,
          status: "designing",
          flow_job_id: null,
        }) ?? "",
        "pr_fix",
      ),
    ).toBe(
      "親Issueの設計の承認と、その後の実装が終わってから`factory:fix`を付け直してください",
    );
  });

  test("tells to wait for the implementation before the relabel", () => {
    expect(
      nextActionFor(
        evaluateDesignGapRerouteParentStatus({
          ...PARENT,
          status: "implementing",
          flow_job_id: null,
        }) ?? "",
        "pr_fix",
      ),
    ).toBe("実装フローの完了を待ってから`factory:fix`を付け直してください");
  });

  test("tells to check the status of the parent before the relabel", () => {
    expect(
      nextActionFor(
        evaluateDesignGapRerouteParentStatus({
          ...PARENT,
          status: "needs_human",
          flow_job_id: null,
        }) ?? "",
        "pr_fix",
      ),
    ).toContain("Consoleで親Issueの作業項目の状態を確認し");
  });

  test("tells that the PR belongs to an old cycle", () => {
    expect(
      nextActionFor(designGapNewerCycleReason(PARENT), "pr_fix"),
    ).toContain("古いサイクル");
  });

  test.each([
    ["a move of the parent", designGapParentMovedReason(PARENT)],
    ["a race that was lost", designGapRerouteRaceLostReason(PARENT)],
  ])("tells to relabel after %s", (_name, reason) => {
    expect(nextActionFor(reason, "pr_fix")).toContain(
      "`factory:fix`を付け直してください",
    );
  });

  test("tells to check the work item when the parent was not found", () => {
    expect(
      nextActionFor(PR_FIX_DESIGN_GAP_PARENT_MISSING_REASON, "pr_fix"),
    ).toContain("Consoleで");
  });

  test("keeps the report of the gap as a separate segment after the reason", () => {
    expect(
      describeReason(
        withGapReport(designGapParentMovedReason(PARENT), "設計の不足"),
      ),
    ).toBe(
      "このPRの修正を始めた後に親Issue #12(作業項目7)が動いたため、設計への差し戻しを止めました; 設計の不足",
    );
  });
});

describe("the reason that stops the preparation while the parent designs", () => {
  test("translates it", () => {
    expect(describeReason(PR_FIX_DESIGN_STAGE_PARENT_REASON)).toBe(
      "親Issueの設計の最中のため修正を止めました",
    );
  });

  test("tells to wait for the design and the implementation, then to retry", () => {
    expect(nextActionFor(PR_FIX_DESIGN_STAGE_PARENT_REASON, "pr_fix")).toBe(
      `設計の承認と、その後の実装の完了を待ってから、Windmillで\`${RETRY}\`を作業項目のIDで実行してください`,
    );
  });
});

describe("the reasons that stop the preparation while the branch is held", () => {
  const IMPLEMENTING =
    "implementation of the branch's work item is running or about to run";
  const DESIGN_STAGE = "the branch's work item is in the design stage";

  test("translates the stop for an implementation that runs or is about to run", () => {
    expect(describeReason(IMPLEMENTING)).toBe(
      "このPRのブランチで実装フローが実行中か開始直前のため修正を止めました",
    );
  });

  test("waits for the implementation before rerunning", () => {
    expect(nextActionFor(IMPLEMENTING, "pr_fix")).toBe(
      `実装フローの完了を待ってから、Windmillで\`${RETRY}\`を作業項目のIDで実行してください`,
    );
  });

  test("translates the stop for the design stage", () => {
    expect(describeReason(DESIGN_STAGE)).toBe(
      "このPRのブランチの作業項目が設計の最中のため修正を止めました",
    );
  });

  test("waits for the design and the implementation before rerunning", () => {
    expect(nextActionFor(DESIGN_STAGE, "pr_fix")).toBe(
      `設計の承認と、その後の実装の完了を待ってから、Windmillで\`${RETRY}\`を作業項目のIDで実行してください`,
    );
  });

  test("keeps translating the earlier wording of the implementation stop", () => {
    expect(
      describeReason("implementation of the branch's work item is running"),
    ).toBe("このPRのブランチで実装フローが実行中のため修正を止めました");
  });

  test("does not point a CI round to a rerun when the design stage stops it", () => {
    expect(nextActionForPrFix(DESIGN_STAGE, true)).not.toContain(RETRY);
  });
});

describe("the reason that holds the review while the branch designs", () => {
  test("translates the hold", () => {
    expect(describeReason(REVIEW_DESIGN_STAGE_REASON)).toBe(
      "このPRのブランチの作業項目が設計の最中のため、レビューを始めませんでした",
    );
  });

  test("tells the reader that nothing is required", () => {
    expect(nextActionFor(REVIEW_DESIGN_STAGE_REASON)).toBe(
      "対応は要りません。設計の承認と実装の完了の後に、レビューが自動で付きます",
    );
  });

  test("does not point to a rerun", () => {
    expect(nextActionFor(REVIEW_DESIGN_STAGE_REASON)).not.toContain(RETRY);
  });
});

describe("shouldAdvanceWatermarks for a design gap", () => {
  test("advances the positions when the parent was returned to the design", () => {
    expect(shouldAdvanceWatermarks("design_gap_reroute_success")).toBe(true);
  });

  test("keeps the positions when the reroute was refused", () => {
    expect(shouldAdvanceWatermarks("design_gap_reroute_failed")).toBe(false);
  });

  test("keeps the positions when the design gap stops at needs_human", () => {
    expect(shouldAdvanceWatermarks("design_gap_needs_human")).toBe(false);
  });
});
