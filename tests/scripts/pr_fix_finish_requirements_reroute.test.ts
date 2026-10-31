// pr_fix_finishが要件の不足で親のIssueを要件定義へ差し戻す結線を、ソースの文面で固定する。
// mainはWindmillの変数・リソースとDBを直接使うためである。
// 差し戻しの手順そのものは`pr_fix_reroute.test.ts`が確かめる。
// 整形や変数名の変更で落ちたときは、結線が変わっていないかを確かめてから文面を直す。

import { describe, expect, test } from "bun:test";

/** コメントを除いたソース。コメントに書いた呼び出しの名前を、結線として数えないため。 */
async function source(): Promise<string> {
  const text = await Bun.file(
    new URL("../../f/factory/steps/pr_fix_finish.ts", import.meta.url),
  ).text();
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("the requirements gap reroute in pr_fix_finish", () => {
  test("moves the parent with the helper that resets design_attempt", async () => {
    expect(await source()).toMatch(
      /casParent: \(expectedFrom, expectedFlowJobId\) =>\s*updateStatusToRequirementsIfLeaseHolder\(\s*parent_work_item_id,\s*expectedFrom,\s*expectedFlowJobId,/,
    );
  });

  test("does not move the parent with the helper that keeps design_attempt", async () => {
    expect(await source()).not.toMatch(
      /updateStatusIfLeaseHolderClearingFlowJobId\(\s*parent_work_item_id,/,
    );
  });

  test("hands the report to the requirements as an automated report", async () => {
    expect(await source()).toContain(
      "feedback: automatedFeedback(limitGapReport(gapReport))",
    );
  });

  test("does not hand the raw report to the requirements", async () => {
    expect(await source()).not.toMatch(/feedback: gapReport\b/);
  });
});

describe("the comment of the switch in pr_fix_finish", () => {
  test("hands the profile of the parent read before the switch", async () => {
    expect(await source()).toContain("previousProfile: parentItem.profile,");
  });

  test("names the requirements gap as the cause", async () => {
    expect(await source()).toContain('cause: "requirements_gap",');
  });

  test("comments after the reroute succeeded", async () => {
    const text = await source();
    const refused = text.indexOf('if (outcome.kind === "refused") {');
    const commented = text.indexOf("postProfileUpgradedComment(");
    expect(refused >= 0 && commented > refused).toBe(true);
  });

  test("posts the comment with the marker of the parent", async () => {
    expect(await source()).toMatch(
      /commentIssue\(\s*client,\s*owner,\s*repo,\s*rerouteGuard\.issueNumber,\s*kind,\s*parent_work_item_id,\s*body,\s*viewer\.login,/,
    );
  });
});
