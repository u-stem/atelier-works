// CI回の配線の構造のテスト。
// 各ステップのmainはWindmillとDBを直接使うので、配線はソースの並びで確かめる。
// 部品そのものの判定は`tests/lib/ci_fix_round.test.ts`が確かめる。
//
// このテストには限界がある。
// ソースの文字列と完全に一致するかを見るので、整形(biome)や変数名の変更で落ちる。落ちたときは、配線が変わったかを確かめて、文字列を直す。
// 結合の誤りを捕まえるのは、呼び出しの前後関係を見るテスト(`indexOf`で順序を比べるもの)である。
// 文字列の一致は、その呼び出しが1か所にあることしか保証しない。呼び出しの引数や条件の中身は、部品のテストが確かめる。

import { describe, expect, test } from "bun:test";
import {
  CI_FIX_ALLOWED_TOOLS,
  CI_FIX_TOOLS,
} from "../../f/factory/lib/ci_fix_round.ts";

const STEPS_DIR = new URL("../../f/factory/steps/", import.meta.url);

async function source(name: string): Promise<string> {
  return Bun.file(new URL(name, STEPS_DIR)).text();
}

/** `needle`の出現回数。 */
function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("the tools of Claude in a CI round", () => {
  test("does not offer Bash in the set of usable tools", () => {
    expect(CI_FIX_TOOLS).not.toContain("Bash");
  });

  test("does not allow Bash without a prompt", () => {
    expect(CI_FIX_ALLOWED_TOOLS).not.toContain("Bash");
  });

  test("allows only tools that are also usable", () => {
    expect(
      CI_FIX_ALLOWED_TOOLS.every((tool) => CI_FIX_TOOLS.includes(tool)),
    ).toBe(true);
  });

  // 修正ステップは、CI回と競合回のそれぞれで、同じ読み取りと編集だけのツールを渡す。
  test("is used by the fix step of a CI round and of a conflict round", async () => {
    const text = await source("pr_fix_apply.ts");
    expect(count(text, "tools: CI_FIX_TOOLS,")).toBe(2);
  });

  test("allows only the shared tools in the fix step of a CI round and of a conflict round", async () => {
    const text = await source("pr_fix_apply.ts");
    expect(count(text, "allowedTools: CI_FIX_ALLOWED_TOOLS,")).toBe(2);
  });

  test("is used by the retry in the verify step", async () => {
    const text = await source("pr_fix_verify.ts");
    expect(count(text, "tools: CI_FIX_TOOLS,")).toBe(1);
  });

  test("allows only the shared tools in the retry of the verify step", async () => {
    const text = await source("pr_fix_verify.ts");
    expect(count(text, "allowedTools: CI_FIX_ALLOWED_TOOLS,")).toBe(1);
  });
});

describe("the finish step of a CI round", () => {
  test("records the head of the work item only in the bookkeeping that a CI round skips", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(
      text.includes(
        "await runPostPushBookkeeping(ciRound, {\n    postReplies: () => postFixReplies(newSha),\n    setHeadSha: () => setHeadSha(work_item_id, newSha),",
      ),
    ).toBe(true);
  });

  test("calls setHeadSha nowhere else", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(count(text, "setHeadSha(")).toBe(1);
  });

  test("posts the replies of the nothing-to-commit path only outside a CI round", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(count(text, "if (!ciRound) await postFixReplies(null);")).toBe(1);
  });

  test("scans the added paths of the scanned tree before the repository lock is taken", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(
      text.indexOf("ciAddedPathsStopReason(\n") <
        text.indexOf("commitAndPush({"),
    ).toBe(true);
  });

  test("lists the added paths from the scanned tree", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(
      count(
        text,
        "listCiAddedPathsInTree(\n        runCommand,\n        worktree_dir,\n        head_sha,\n        scanned.treeSha,",
      ),
    ).toBe(1);
  });
});

describe("the fix step of a recomputed lock", () => {
  test("tries the recomputation before the daily budget is checked", async () => {
    const text = await source("pr_fix_apply.ts");
    expect(
      text.indexOf("await applyMetadataRound({") <
        text.indexOf("dailyBudgetStatus(config)"),
    ).toBe(true);
  });

  test("tries the recomputation only in a CI round", async () => {
    const text = await source("pr_fix_apply.ts");
    expect(
      count(
        text,
        "if (ci_check_id !== null) {\n    const metadataResult = await applyMetadataRound({",
      ),
    ).toBe(1);
  });

  test("calls the recomputation in one place", async () => {
    const text = await source("pr_fix_apply.ts");
    expect(count(text, "await applyMetadataRound(")).toBe(1);
  });

  test("turns the result of the round into the result of the step through one function", async () => {
    const text = await source("pr_fix_apply.ts");
    expect(count(text, "metadataApplyResult(round)")).toBe(1);
  });
});

describe("the finish step of a recomputed lock", () => {
  test("passes the check of the staged lock to the inspection of the staged changes", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(count(text, "rehashCheck: async () =>")).toBe(1);
  });

  test("builds the gate of the staged lock in one place", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(count(text, "await stagedRehashGate({")).toBe(1);
  });

  test("takes a recomputed lock as a candidate only when the changes were read completely", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(count(text, "candidate: isRehashCandidate(collected),")).toBe(1);
  });

  test("reads the staged lock as bytes", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(
      count(text, "readStagedRootLock(runCommandBytes, worktree_dir)"),
    ).toBe(1);
  });

  test("checks the base tip again before the commit and the push", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(
      text.indexOf("await rehashPushStopReason(") <
        text.indexOf("commitAndPush({"),
    ).toBe(true);
  });

  test("builds the planner only in a CI round", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(
      count(text, "if (ciRound) {\n    const planner = githubRehashPlanner({"),
    ).toBe(1);
  });

  test("builds the planner nowhere else", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(count(text, "githubRehashPlanner({")).toBe(1);
  });
});

describe("the kind of the round in the check of a recomputed lock", () => {
  test("reads the kind of the round again in the verify step", async () => {
    const text = await source("pr_fix_verify.ts");
    expect(count(text, "isRehashRound: rehashRoundProbe({")).toBe(1);
  });

  test("reads the kind of the round again in the finish step", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(count(text, "isRehashRound: rehashRoundProbe({")).toBe(1);
  });
});

describe("the verify step of a recomputed lock", () => {
  test("confirms the lock against an independent recomputation", async () => {
    const text = await source("pr_fix_verify.ts");
    expect(count(text, "rehashCheck: async () => {")).toBe(1);
  });

  test("turns the confirmation into the verdict through one function", async () => {
    const text = await source("pr_fix_verify.ts");
    expect(count(text, "return await confirmationVerdict(")).toBe(1);
  });

  test("resets the confirmation at every inspection", async () => {
    const text = await source("pr_fix_verify.ts");
    expect(
      count(
        text,
        "inspectChanges: async () => {\n        rehashVerified = false;",
      ),
    ).toBe(1);
  });
});

describe("the review generate step", () => {
  test("looks up the kind of the round through the helper that falls back to null", async () => {
    const text = await source("pr_review_generate.ts");
    expect(
      count(
        text,
        "fixRoundOrNull(\n    () => findFixRoundKindToReview(owner, repo, pr_number, review_sha),",
      ),
    ).toBe(1);
  });
});
