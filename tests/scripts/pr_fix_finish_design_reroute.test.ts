// pr_fix_finishが、PRの修正の設計の不足を、親のIssueを設計へ戻す手順につなぐ結線を、ソースの文面で固定する。
// mainはWindmillの変数・リソースとDBを直接使うためである。
// 戻す手順そのものは`pr_fix_design_reroute.test.ts`が確かめる。
// 整形や変数名の変更で落ちたときは、結線が変わっていないかを確かめてから文面を直す。

import { describe, expect, test } from "bun:test";

/** コメントを除いたソース。コメントに書いた呼び出しの名前を、結線として数えないため。 */
async function source(): Promise<string> {
  const text = await Bun.file(
    new URL("../../f/factory/steps/pr_fix_finish.ts", import.meta.url),
  ).text();
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** 設計の不足を戻す分岐。次の分岐(pushする経路)の手前までを返す。 */
async function designGapBranch(): Promise<string> {
  const code = await source();
  const start = code.indexOf('if (action.kind === "design_gap_reroute")');
  const end = code.indexOf("if (commit_subject === null)");
  return start < 0 || end < start ? "" : code.slice(start, end);
}

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/**
 * 設計の不足の判定に、設定の`design_enabled`をそのまま渡す呼び出しの形。
 * 値の直後が`,`でなければ当たらない。`|| true`のような後ろの式で値を変える書き換えを通さないためである。
 */
const DECIDE_DESIGN_GAP_CONDITION =
  /\bdecideDesignGapAction\(\{\s*designEnabled:\s*config\.design_enabled\s*,/;

describe("the outcomes that pr_fix_finish accepts", () => {
  test("lists design_gap", async () => {
    expect(await source()).toMatch(
      /const ALL_OUTCOMES: readonly PrFixFinishOutcome\[\] = \[[^\]]*"design_gap"/,
    );
  });
});

describe("the design gap branch of pr_fix_finish", () => {
  test("exists", async () => {
    expect((await designGapBranch()).length).toBeGreaterThan(0);
  });

  test("decides the action from the design_enabled setting as it is", async () => {
    expect(await designGapBranch()).toMatch(DECIDE_DESIGN_GAP_CONDITION);
  });

  test("decides the action of a design gap once in the whole step", async () => {
    expect(countOf(await source(), "decideDesignGapAction(")).toBe(1);
  });

  test("builds the start of the design flow once in the whole step", async () => {
    expect(countOf(await source(), "buildStartDesign(")).toBe(1);
  });

  test("starts the design flow once in the whole step", async () => {
    expect(countOf(await source(), "startDesign(")).toBe(1);
  });

  test("counts the rejections with the three notes, the prefix of the PR fix included", async () => {
    expect(await designGapBranch()).toMatch(
      /countAppliedDesignRejections\(\s*parent_work_item_id,\s*DESIGN_REGENERATING_NOTE,\s*DESIGN_REJECTED_EXHAUSTED_PREFIX,\s*PR_FIX_DESIGN_GAP_NOTE_PREFIX,\s*\)/,
    );
  });

  test("stops at needs_human when the design is disabled", async () => {
    expect(await designGapBranch()).toMatch(
      /if \(designAction === "disabled"\) \{[^}]*finalizeTerminal\(\s*"needs_human"/,
    );
  });

  test("stops at needs_human when the limit is reached", async () => {
    expect(await designGapBranch()).toMatch(
      /if \(designAction === "exhausted"\) \{[^}]*finalizeTerminal\(\s*"needs_human"/,
    );
  });

  test("builds the start of the design flow only after both stops", async () => {
    const branch = await designGapBranch();
    expect(branch.indexOf('designAction === "exhausted"')).toBeLessThan(
      branch.indexOf("buildStartDesign("),
    );
  });

  test("calls the reroute of the PR fix to design only after the stop at the limit", async () => {
    const branch = await designGapBranch();
    const stop = branch.indexOf('designAction === "exhausted"');
    const call = branch.indexOf("reroutePrFixToDesign(");
    expect(stop > -1 && call > stop).toBe(true);
  });

  test("calls the reroute of the PR fix to design once", async () => {
    expect(countOf(await designGapBranch(), "reroutePrFixToDesign(")).toBe(1);
  });

  test("records the round before it reads the parent", async () => {
    const branch = await designGapBranch();
    const record = branch.indexOf('outcome: "design_gap"');
    expect(
      record > -1 &&
        record < branch.indexOf("getWorkItem(parent_work_item_id)"),
    ).toBe(true);
  });

  test("reads the parent before it decides the action", async () => {
    const branch = await designGapBranch();
    expect(branch.indexOf("getWorkItem(parent_work_item_id)")).toBeLessThan(
      branch.indexOf("decideDesignGapAction("),
    );
  });

  test("writes the note with the prefix of the PR fix and the limited report", async () => {
    expect(await designGapBranch()).toMatch(
      /`\$\{PR_FIX_DESIGN_GAP_NOTE_PREFIX\}\$\{limitGapReport\(gapReport\)\}`/,
    );
  });

  test("moves the parent that holds the lease it was read with", async () => {
    expect(await designGapBranch()).toMatch(
      /returnToDesigningFromPrFixIfLeaseHolder\(\s*parent_work_item_id,\s*expectedFlowJobId,/,
    );
  });

  test("hands the report to the design flow through the feedback it is given", async () => {
    expect(await designGapBranch()).toMatch(
      /buildStartDesign\(\s*config,\s*\{[^}]*\},\s*undefined,\s*feedback,?\s*\)/,
    );
  });

  test("asks whether a newer cycle replaced the parent", async () => {
    expect(await designGapBranch()).toMatch(
      /hasNewerCycle: \(\) =>\s*hasNewerIssueCycle\(parent_work_item_id\)/,
    );
  });

  test("asks whether the parent moved after this fix started", async () => {
    expect(await designGapBranch()).toMatch(
      /parentMovedSinceFixStarted: \(\) =>\s*hasParentTransitionSinceFixStarted\(\s*parent_work_item_id,\s*work_item_id,?\s*\)/,
    );
  });

  test("advances the positions of the fix through the dependency of the reroute", async () => {
    expect(await designGapBranch()).toMatch(
      /bumpWatermarks: \(\) =>\s*bumpWatermarks\(work_item_id, \{/,
    );
  });

  test("blocks the fix from fixing", async () => {
    expect(await designGapBranch()).toMatch(
      /updateStatusIfCurrent\(\s*work_item_id,\s*"fixing",\s*"blocked",/,
    );
  });

  test("does not read the setting of the design stage anywhere else in the step", async () => {
    expect(countOf(await source(), "design_enabled")).toBe(1);
  });
});

describe("the design gap of a work item without a parent", () => {
  test("records the round", async () => {
    const code = await source();
    const start = code.indexOf('if (action.kind === "design_gap_needs_human")');
    const end = code.indexOf('if (action.kind === "design_gap_reroute")');
    expect(code.slice(start, end)).toContain('outcome: "design_gap"');
  });

  test("stops at needs_human", async () => {
    const code = await source();
    const start = code.indexOf('if (action.kind === "design_gap_needs_human")');
    const end = code.indexOf('if (action.kind === "design_gap_reroute")');
    expect(code.slice(start, end)).toContain('finalizeTerminal("needs_human"');
  });
});
