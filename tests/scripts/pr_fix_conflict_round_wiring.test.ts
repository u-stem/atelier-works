// 競合回の配線のテスト。
// 各ステップのmainはWindmillとDBを直接使うので、判断は注入できる関数で、配線はソースの並びとflow.yamlで確かめる。
// ソースの文字列と完全に一致するかを見るテストは、整形や変数名の変更で落ちる。落ちたときは、配線が変わったかを確かめて、文字列を直す。
// 結合の誤りを捕まえるのは、呼び出しの前後関係を見るテスト(`indexOf`で順序を比べるもの)である。
// 部品そのものの判定は`tests/lib/conflict_fix_*.test.ts`と、`pr_fix_conflict_verify.test.ts`、`pr_fix_conflict_finish.test.ts`が確かめる。

import { describe, expect, test } from "bun:test";
import { CHECK_IMAGE_STALE_REASON } from "../../f/factory/lib/check_sandbox.ts";
import {
  CONFLICT_BLOCKED_NOTES,
  CONFLICT_ROUND_DETAILS,
  conflictRoundReason,
} from "../../f/factory/lib/conflict_fix_round.ts";
import { holdReasonForConflictStoppedItem } from "../../f/factory/lib/pr_conflict_fix_recovery.ts";
import type { PrConflictFixHoldReason } from "../../f/factory/lib/pr_conflict_support.ts";
import { MERGE_COMMIT_MESSAGE } from "../../f/factory/lib/workspace.ts";
import { conflictApplyResult } from "../../f/factory/steps/pr_fix_apply.ts";
import { fixedFeedbackCollectResult } from "../../f/factory/steps/pr_fix_collect.ts";
import { stopBeforeCommitTerminal } from "../../f/factory/steps/pr_workflow_support.ts";

const STEPS_DIR = new URL("../../f/factory/steps/", import.meta.url);
const LIB_DIR = new URL("../../f/factory/lib/", import.meta.url);

async function source(name: string): Promise<string> {
  return Bun.file(new URL(name, STEPS_DIR)).text();
}

async function libSource(name: string): Promise<string> {
  return Bun.file(new URL(name, LIB_DIR)).text();
}

/** `needle`の出現回数。 */
function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("the collect step of a conflict round", () => {
  test("reads no feedback and returns the fixed result for a conflict round", () => {
    expect(
      fixedFeedbackCollectResult({ ci_check_id: null, conflict_check_id: 4 }),
    ).toMatchObject({
      outcome: "proceed",
      reviews: [],
      comments: [],
      trigger_review_ids: [],
    });
  });

  test("leaves the watermarks at zero for a conflict round", () => {
    expect(
      fixedFeedbackCollectResult({ ci_check_id: null, conflict_check_id: 4 }),
    ).toMatchObject({
      max_review_id: 0,
      max_comment_id: 0,
      max_review_comment_id: 0,
    });
  });

  test("returns the fixed result for a CI round", () => {
    expect(
      fixedFeedbackCollectResult({ ci_check_id: 4, conflict_check_id: null })
        ?.outcome,
    ).toBe("proceed");
  });

  test("returns nothing for a round that answers feedback", () => {
    expect(
      fixedFeedbackCollectResult({
        ci_check_id: null,
        conflict_check_id: null,
      }),
    ).toBeNull();
  });

  test("returns the fixed result before it reads anything from GitHub", async () => {
    const text = await source("pr_fix_collect.ts");
    expect(
      text.indexOf("fixedFeedbackCollectResult(workItem)") <
        text.indexOf("getViewer(client)"),
    ).toBe(true);
  });

  test("asks for the fixed result in one place", async () => {
    const text = await source("pr_fix_collect.ts");
    expect(count(text, "fixedFeedbackCollectResult(workItem)")).toBe(1);
  });
});

describe("the prepare step of a conflict round", () => {
  test("does not check the limit of the fix rounds", async () => {
    const text = await source("pr_fix_prepare.ts");
    expect(count(text, "    ciRound || conflictRound,\n")).toBe(1);
  });

  test("checks the time settings of the conflict round", async () => {
    const text = await source("pr_fix_prepare.ts");
    expect(
      count(
        text,
        "    : conflictRound\n      ? conflictRoundTimeoutMisfit(config)",
      ),
    ).toBe(1);
  });

  test("checks the conflict check row before it prepares the worktree", async () => {
    const text = await source("pr_fix_prepare.ts");
    expect(
      text.indexOf("evaluateConflictRoundPrepareGuard({") <
        text.indexOf("createGtrWorktree({"),
    ).toBe(true);
  });

  test("merges the base only after the .git pointer of the worktree was recorded", async () => {
    const text = await source("pr_fix_prepare.ts");
    expect(
      text.indexOf("readAndVerifyWorktreeGitPointer({") <
        text.indexOf("mergeBaseIntoWorktree({"),
    ).toBe(true);
  });

  test("merges the base in one place, and only in a conflict round", async () => {
    const text = await source("pr_fix_prepare.ts");
    expect(
      count(
        text,
        "  if (conflictRound) {\n    // baseをmergeして基準コミットを作る。無視されたファイルの片付けは`mergeBaseIntoWorktree`が行う。\n    let merge: Awaited<ReturnType<typeof mergeBaseIntoWorktree>>;",
      ) + count(text, "mergeBaseIntoWorktree({"),
    ).toBe(2);
  });

  test("gives the merge the recorded pointer, the head and the base branch of the pull request", async () => {
    const text = await source("pr_fix_prepare.ts");
    expect(
      count(
        text,
        "        worktreeGitPointer,\n        ghToken,\n        prHeadSha: pr.headSha,\n        baseBranch: pr.baseRef,\n",
      ),
    ).toBe(1);
  });

  test("records the baseline commit that the merge made", async () => {
    const text = await source("pr_fix_prepare.ts");
    expect(count(text, "baseline_sha: plan.autoSha,")).toBe(1);
  });

  test("records the base sha", async () => {
    const text = await source("pr_fix_prepare.ts");
    expect(count(text, "base_sha: plan.baseSha,")).toBe(1);
  });

  test("records the tree of the baseline commit", async () => {
    const text = await source("pr_fix_prepare.ts");
    expect(count(text, "auto_tree_sha: plan.autoTreeSha,")).toBe(1);
  });

  test("records the conflicted paths", async () => {
    const text = await source("pr_fix_prepare.ts");
    expect(count(text, "conflicted_paths: plan.conflictedPaths,")).toBe(1);
  });

  test("records the blobs of the three versions of every conflicted path", async () => {
    const text = await source("pr_fix_prepare.ts");
    expect(count(text, "conflict_blobs: plan.conflictBlobs,")).toBe(1);
  });

  test("carries the conflict check id and the recorded values in the result that proceeds", async () => {
    const text = await source("pr_fix_prepare.ts");
    expect(
      count(
        text,
        "    conflict_check_id: workItem.conflict_check_id,\n    ...conflict,\n",
      ),
    ).toBe(1);
  });

  test("returns the up_to_date outcome without a reason", async () => {
    const text = await source("pr_fix_prepare.ts");
    expect(
      count(
        text,
        '        outcome: "conflict_up_to_date",\n        reason: null,\n',
      ),
    ).toBe(1);
  });

  test("returns the blocked outcome with the reason of the plan", async () => {
    const text = await source("pr_fix_prepare.ts");
    expect(
      count(
        text,
        '        outcome: "conflict_blocked",\n        reason: plan.reason,\n',
      ),
    ).toBe(1);
  });

  test("returns the outcome of the guard as it is", async () => {
    const text = await source("pr_fix_prepare.ts");
    expect(
      count(
        text,
        "        outcome: conflictGuard.outcome,\n        reason: conflictGuard.reason,\n",
      ),
    ).toBe(1);
  });

  test("gives the stop of a worktree that another process holds the fixed note in a conflict round", async () => {
    const text = await source("pr_fix_prepare.ts");
    expect(
      count(
        text,
        "roundStopReason(\n          conflictRound,\n          CONFLICT_ROUND_DETAILS.worktreeBusy,\n          err.message,",
      ),
    ).toBe(1);
  });

  test("gives the stop for a running implement flow the fixed note in a conflict round", async () => {
    const text = await source("pr_fix_prepare.ts");
    expect(count(text, "CONFLICT_ROUND_DETAILS.implementRunning,")).toBe(2);
  });

  test("gives a head that moved while the base was merged the fixed note", async () => {
    const text = await source("pr_fix_prepare.ts");
    expect(
      count(
        text,
        '      return {\n        outcome: "guard_blocked",\n        reason: conflictRoundReason(CONFLICT_ROUND_DETAILS.headMoved),',
      ),
    ).toBe(1);
  });

  test("returns a worktree that is not as expected as a guard stop", async () => {
    const text = await source("pr_fix_prepare.ts");
    expect(
      count(
        text,
        '      if (err instanceof CommitBlockedError) {\n        return {\n          outcome: "guard_blocked",\n          reason: err.message,',
      ),
    ).toBe(1);
  });
});

describe("the fix step of a conflict round", () => {
  test("finishes a merge without conflicts before the daily budget is checked", async () => {
    const text = await source("pr_fix_apply.ts");
    expect(
      text.indexOf("conflictApplyResult(CONFLICT_CLEAN_MERGE_RESULT)") <
        text.indexOf("dailyBudgetStatus(config)"),
    ).toBe(true);
  });

  test("starts Claude for the conflicted files only after the daily budget is checked", async () => {
    const text = await source("pr_fix_apply.ts");
    expect(
      text.indexOf("dailyBudgetStatus(config)") <
        text.indexOf("await applyConflictRound({"),
    ).toBe(true);
  });

  test("asks Claude for the output of a conflict round", async () => {
    const text = await source("pr_fix_apply.ts");
    expect(count(text, "jsonSchema: CONFLICT_FIX_SCHEMA,")).toBe(1);
  });

  test("accepts only the output of a conflict round from Claude", async () => {
    const text = await source("pr_fix_apply.ts");
    expect(count(text, "isStructuredOutput: isConflictFixClaudeOutput,")).toBe(
      1,
    );
  });

  test("throws the failure of a Claude run with the message that the recovery matches", async () => {
    const text = await source("pr_fix_apply.ts");
    expect(count(text, "conflictClaudeFailedMessage(result.reason)")).toBe(1);
  });

  test("blocks a round whose merge was not recorded", async () => {
    const text = await source("pr_fix_apply.ts");
    expect(
      count(
        text,
        "  if (conflictRound && conflictInput === null) {\n    return blockedResult(CONFLICT_MERGE_NOT_RECORDED_REASON);",
      ),
    ).toBe(1);
  });

  test("gives the result of a finished fix the fixed commit message and no reply", () => {
    expect(
      conflictApplyResult({
        kind: "finished",
        outcome: "done",
        reason: null,
        summary: "s",
      }),
    ).toEqual({
      outcome: "done",
      reason: null,
      summary: "s",
      replies: [],
      commit_subject: MERGE_COMMIT_MESSAGE,
      commit_body: null,
    });
  });

  test("gives a blocked result no commit message", () => {
    expect(
      conflictApplyResult({
        kind: "finished",
        outcome: "blocked",
        reason: "conflict round: claude blocked",
        summary: "",
      }).commit_subject,
    ).toBeNull();
  });

  test("turns a refusal before Claude started into a blocked result with its reason", () => {
    expect(conflictApplyResult({ kind: "blocked", reason: "x" })).toMatchObject(
      { outcome: "blocked", reason: "x", replies: [] },
    );
  });
});

describe("the verify step of a conflict round", () => {
  test("inspects the resolution through one dependency", async () => {
    const text = await source("pr_fix_verify.ts");
    expect(count(text, "inspectConflictResolution(inspectDeps, {")).toBe(1);
  });

  test("builds the git reads of the inspection in one place", async () => {
    const text = await source("pr_fix_verify.ts");
    expect(count(text, "gitConflictInspectDeps({")).toBe(1);
  });

  test("hands the inspection the tree of the baseline commit", async () => {
    const text = await source("pr_fix_verify.ts");
    expect(count(text, "            autoTreeSha,\n")).toBe(1);
  });

  test("expects the baseline commit at HEAD", async () => {
    const text = await source("pr_fix_verify.ts");
    expect(count(text, "        baselineSha,\n        branch,\n")).toBe(1);
  });

  test("cleans the ignored files that the checks left, in both rounds that clean them", async () => {
    const text = await source("pr_fix_verify.ts");
    expect(count(text, "removeIgnoredFilesIfPointerIntact({")).toBe(2);
  });
});

describe("the finish step of a conflict round", () => {
  test("lists the outcomes of the conflict round as known outcomes", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(
      count(text, '  "conflict_up_to_date",\n  "conflict_blocked",\n];'),
    ).toBe(1);
  });

  test("sends no notification of a conflict round", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(
      text.indexOf("    if (conflictRound) return;\n") <
        text.indexOf('      kind: "needs_human",\n      instance_name'),
    ).toBe(true);
  });

  test("returns before the push of a round that answers feedback", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(
      text.indexOf("    return finishConflictPush();") <
        text.indexOf("const commitMessage = composeCommitMessage("),
    ).toBe(true);
  });

  test("keeps the reason of a stopped round as the note, without a prefix", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(
      count(
        text,
        'await finalizeTerminal("blocked", reason ?? "safety guard failed");',
      ),
    ).toBe(1);
  });

  test("gives a head that moved before the push the fixed note in a conflict round", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(
      count(
        text,
        "roundStopReason(\n        conflictRound,\n        CONFLICT_ROUND_DETAILS.headMovedAtPush,\n        reason,\n      )",
      ),
    ).toBe(1);
  });

  test("gives the stop of a busy worktree before the push the fixed note, and logs the holder", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(
      count(text, "(holder) => {\n              log.warn(") +
        count(text, "CONFLICT_ROUND_DETAILS.worktreeBusy"),
    ).toBe(2);
  });

  test("hands the verified tree to the push", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(
      count(
        text,
        "{ prHeadSha: head_sha, verifiedTreeSha: verified_tree_sha }",
      ),
    ).toBe(1);
  });

  test("ends a blocked conflict with a fixed note only", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(
      count(
        text,
        "    if (reason === null || !CONFLICT_BLOCKED_NOTES.includes(reason)) {",
      ) + count(text, 'await finalizeTerminal("needs_human", reason, reason);'),
    ).toBe(2);
  });

  test("never puts the prefix of a conflict round on a reason that it did not write", async () => {
    const offenders: string[] = [];
    for (const file of [
      "pr_fix_prepare.ts",
      "pr_fix_apply.ts",
      "pr_fix_verify.ts",
      "pr_fix_finish.ts",
    ]) {
      const text = await source(file);
      for (const match of text.matchAll(/conflictRoundReason\(([^)]*)/g)) {
        const argument = (match[1] ?? "").trim();
        const fixed = argument.startsWith("CONFLICT_ROUND_DETAILS.");
        if (!fixed) offenders.push(`${file}: ${argument}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("pushes with the merge commit, and with nothing that records or announces a fix", async () => {
    const text = await source("pr_fix_finish.ts");
    const start = text.indexOf("async function finishConflictPush()");
    const body = text.slice(start, text.indexOf("\n  if (ciRound) {", start));
    const found = [
      "setHeadSha",
      "bumpWatermarks",
      "postFixReplies",
      "requestRereview",
      "notifyBestEffort",
      "pr_fixed",
      "addNoticeUnlessUnresolved(",
      "commitAndPush(",
    ].filter((word) => body.includes(word));
    expect(found).toEqual([]);
  });

  test("pushes through pushMergeCommit", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(count(text, "pushMergeCommit({")).toBe(1);
  });

  test("scans the difference between the baseline commit and the scanned tree", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(
      count(text, "fromSha: baselineSha,\n                toTreeSha: treeSha,"),
    ).toBe(1);
  });

  test("inspects the staged changes against the baseline commit", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(
      count(
        text,
        "inspectStagedChanges(runCommand, worktree_dir, baselineSha)",
      ),
    ).toBe(1);
  });

  test("pushes the merge of the recorded base and the recorded baseline commit", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(
      count(
        text,
        "            baseSha,\n            baseBranch: request.baseBranch,\n            autoSha: baselineSha,",
      ),
    ).toBe(1);
  });

  test("keeps the reason of a stale image as the note of a stopped push", () => {
    const stale = `${CHECK_IMAGE_STALE_REASON}: /usr/bin/getfacl is missing`;
    expect(stopBeforeCommitTerminal(stale)).toMatchObject({
      toStatus: "blocked",
      recordsRound: false,
      statusNote: stale,
    });
  });
});

/**
 * 競合回の注記の固定文ごとに、保留の理由に写る先。写らないものは`null`にする。
 * 写らない理由は、行に最終の保留を書かない回(pushせずに終えた回と一時の停止)だからである。
 * `CONFLICT_ROUND_DETAILS`に固定文を足すと、この表に行を足すまで下の網羅の検査が落ちる。
 */
const DETAIL_HOLDS: readonly (readonly [
  keyof typeof CONFLICT_ROUND_DETAILS,
  PrConflictFixHoldReason | null,
])[] = [
  ["baseNotDefault", "base_not_default"],
  ["baseChangesWorkflows", "base_changes_workflows"],
  ["protectedPath", "protected_path"],
  ["unresolvable", "unresolvable"],
  ["checkFailed", "check_failed"],
  ["markerMissing", "marker_missing"],
  ["upToDate", null],
  ["baseChanged", null],
  ["rowMissing", null],
  ["rowNotConflicted", null],
  ["rowBoundToAnother", null],
  ["episodeOver", null],
  ["headMoved", null],
  ["headMovedAtPush", null],
  ["treeChangedDuringChecks", null],
  ["worktreeBusy", null],
  ["implementRunning", null],
];

describe("the notes of a stopped conflict round", () => {
  test("lists every fixed text of a conflict round in the table of holds", () => {
    const listed: string[] = DETAIL_HOLDS.map(([key]) => key);
    expect(listed.sort()).toEqual(Object.keys(CONFLICT_ROUND_DETAILS).sort());
  });

  test.each(DETAIL_HOLDS)("maps the note of %s to the hold %p", (key, hold) => {
    expect(
      holdReasonForConflictStoppedItem(
        conflictRoundReason(CONFLICT_ROUND_DETAILS[key]),
      ),
    ).toBe(hold);
  });

  test("matches a note by its head in two places only, the stale image and the failure of Claude", async () => {
    const text = await libSource("pr_conflict_fix_recovery.ts");
    expect(count(text, ".startsWith(")).toBe(2);
  });

  test("matches the failure of Claude by the one prefix constant", async () => {
    const text = await libSource("pr_conflict_fix_recovery.ts");
    expect(count(text, "startsWith(CONFLICT_CLAUDE_FAILED_NOTE_PREFIX)")).toBe(
      1,
    );
  });

  test("lets the conflict_blocked outcome carry only the notes that map to a hold", () => {
    expect([...CONFLICT_BLOCKED_NOTES]).toEqual(
      [
        CONFLICT_ROUND_DETAILS.baseNotDefault,
        CONFLICT_ROUND_DETAILS.baseChangesWorkflows,
        CONFLICT_ROUND_DETAILS.protectedPath,
        CONFLICT_ROUND_DETAILS.unresolvable,
      ].map(conflictRoundReason),
    );
  });
});

describe("the nonce of the inspection", () => {
  test("draws the nonce once for the reconstruction and the check", async () => {
    const text = await libSource("conflict_fix_verify.ts");
    expect(count(text, "deps.newNonce()")).toBe(1);
  });

  test("reconstructs every file with the drawn nonce", async () => {
    const text = await libSource("conflict_fix_verify.ts");
    expect(count(text, "deps.reconstruct(blobs, nonce)")).toBe(1);
  });

  test("checks the resolution with the drawn nonce", async () => {
    const text = await libSource("conflict_fix_verify.ts");
    expect(
      count(text, "checkConflictResolution({ nonce, files, changes })"),
    ).toBe(1);
  });

  test("reads the resolved text from the tree, not from the working file", async () => {
    const text = await libSource("conflict_fix_verify.ts");
    expect([text.includes("node:fs"), text.includes("readFile(")]).toEqual([
      false,
      false,
    ]);
  });
});

// ---------------------------------------------------------------------------
// flow.yaml
// ---------------------------------------------------------------------------

const FLOW = await Bun.file(
  new URL("../../f/factory/pr_fix__flow/flow.yaml", import.meta.url),
).text();

/** 1つのモジュールのテキスト。`- id:`の行から、次のモジュールか`failure_module`の手前まで。 */
function moduleBlock(id: string): string {
  const start = FLOW.indexOf(`- id: ${id}\n`);
  if (start === -1) throw new Error(`module ${id} not found in flow.yaml`);
  const rest = FLOW.slice(start + 1);
  const next = rest.search(/\n\s+- id: |\n {2}failure_module:/);
  return next === -1 ? rest : rest.slice(0, next);
}

/** モジュールの`input_transforms`のキー。 */
function transformKeys(id: string): string[] {
  const block = moduleBlock(id);
  const start = block.indexOf("input_transforms:\n");
  const end = block.indexOf("        path: f/factory/steps/");
  return [...block.slice(start, end).matchAll(/^ {10}(\w+):$/gm)].map(
    (match) => match[1] ?? "",
  );
}

/** ステップのmainの引数のうち、`name: type,`の形で宣言した名前(既定値の無いもの)と、すべての名前。 */
async function mainParams(
  file: string,
): Promise<{ readonly all: string[]; readonly required: string[] }> {
  const text = await source(file);
  const start = text.indexOf("export async function main(");
  const end = text.indexOf("): Promise<", start);
  const list = text.slice(start, end);
  // 引数は`name: type`か`name: type = default`の形で、1行に1つ書く。1つだけのときは1行にまとめて書く。
  return {
    all: [...list.matchAll(/(?<=[(\s])(\w+)\??: /g)].map(
      (match) => match[1] ?? "",
    ),
    required: [...list.matchAll(/(?<=[(\s])(\w+): [^=\n,]+(?:,|$)/gm)].map(
      (match) => match[1] ?? "",
    ),
  };
}

const STEP_FILES: readonly (readonly [string, string])[] = [
  ["pr_fix_prepare", "pr_fix_prepare.ts"],
  ["pr_fix_collect", "pr_fix_collect.ts"],
  ["pr_fix_apply", "pr_fix_apply.ts"],
  ["pr_fix_verify", "pr_fix_verify.ts"],
  ["pr_fix_finish", "pr_fix_finish.ts"],
];

describe("the flow of a conflict round", () => {
  test.each(STEP_FILES)(
    "passes only values that the main of %s declares",
    async (id, file) => {
      const { all } = await mainParams(file);
      expect(transformKeys(id).filter((key) => !all.includes(key))).toEqual([]);
    },
  );

  test.each(STEP_FILES)(
    "passes every value that the main of %s needs",
    async (id, file) => {
      const { required } = await mainParams(file);
      expect(
        required.filter((key) => !transformKeys(id).includes(key)),
      ).toEqual([]);
    },
  );

  const CONFLICT_VALUES: Record<string, readonly string[]> = {
    pr_fix_apply: ["conflict_check_id", "base_sha", "conflicted_paths"],
    pr_fix_verify: [
      "conflict_check_id",
      "baseline_sha",
      "base_sha",
      "auto_tree_sha",
      "conflicted_paths",
      "conflict_blobs",
    ],
    pr_fix_finish: [
      "conflict_check_id",
      "baseline_sha",
      "base_sha",
      "auto_tree_sha",
      "conflicted_paths",
      "conflict_blobs",
    ],
  };

  for (const [step, keys] of Object.entries(CONFLICT_VALUES)) {
    for (const key of keys) {
      test(`passes ${key} of the prepare step to ${step}, with null as the default`, () => {
        expect(moduleBlock(step)).toContain(
          `          ${key}:\n            type: javascript\n            expr: results.pr_fix_prepare.${key} ?? null\n`,
        );
      });
    }
  }

  test("skips the collect, apply and verify steps unless the prepare step proceeds", () => {
    expect(
      ["pr_fix_collect", "pr_fix_apply", "pr_fix_verify"].map((step) =>
        moduleBlock(step).includes(
          'results.pr_fix_prepare.outcome !== "proceed"',
        ),
      ),
    ).toEqual([true, true, true]);
  });

  test("passes the verified tree of the verify step to the finish step, with null as the default", () => {
    expect(moduleBlock("pr_fix_finish")).toContain(
      "          verified_tree_sha:\n            type: javascript\n            expr: results.pr_fix_verify?.verified_tree_sha ?? null\n",
    );
  });

  test("hands the outcome of the prepare step to the finish step when nothing else ran", () => {
    expect(moduleBlock("pr_fix_finish")).toContain(
      "? results.pr_fix_prepare.outcome : results.pr_fix_collect.outcome",
    );
  });
});
