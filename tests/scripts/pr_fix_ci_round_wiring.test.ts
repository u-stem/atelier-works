// CI回の配線の構造のテスト。
// 各ステップのmainはWindmillとDBを直接使うので、配線はソースの並びで確かめる。
// 部品そのものの判定は`tests/lib/ci_fix_round.test.ts`が確かめる。

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

  test("is used by the fix step", async () => {
    const text = await source("pr_fix_apply.ts");
    expect([
      count(text, "tools: CI_FIX_TOOLS,"),
      count(text, "allowedTools: CI_FIX_ALLOWED_TOOLS,"),
    ]).toEqual([1, 1]);
  });

  test("is used by the retry in the verify step", async () => {
    const text = await source("pr_fix_verify.ts");
    expect([
      count(text, "tools: CI_FIX_TOOLS,"),
      count(text, "allowedTools: CI_FIX_ALLOWED_TOOLS,"),
    ]).toEqual([1, 1]);
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
  test("passes the confirmed recomputation to the check of the staged changes", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(
      count(
        text,
        "rehashCheck: async () => {\n                const confirmed = rehash.confirmed;",
      ),
    ).toBe(1);
  });

  test("compares the staged lock with the confirmed one inside the check", async () => {
    const text = await source("pr_fix_finish.ts");
    const start = text.indexOf("rehashCheck: async () => {");
    const body = text.slice(start, start + 600);
    expect(
      body.includes("readStagedRootLock(") &&
        body.includes("bytesEqual(staged, confirmed.lockBytes)"),
    ).toBe(true);
  });

  test("reads the staged lock as bytes", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(
      count(text, "readStagedRootLock(\n                  runCommandBytes,"),
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
      text.indexOf(
        "if (ciRound) {\n    const planner = githubRehashPlanner({",
      ) > 0,
    ).toBe(true);
  });

  test("builds the planner nowhere else", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(count(text, "githubRehashPlanner({")).toBe(1);
  });
});

describe("the verify step of a recomputed lock", () => {
  test("confirms the lock against an independent recomputation", async () => {
    const text = await source("pr_fix_verify.ts");
    expect(count(text, "rehashCheck: async () => {")).toBe(1);
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
  test("looks up the CI round diff through the helper that falls back to false", async () => {
    const text = await source("pr_review_generate.ts");
    expect(
      count(
        text,
        "ciRoundDiffOrFalse(\n    () => hasCiRoundDiffToReview(owner, repo, pr_number, review_sha),",
      ),
    ).toBe(1);
  });
});
