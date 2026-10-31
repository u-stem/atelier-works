// implement_finishが、仕様がIssueの実装(承認を省く進め方)を扱う結線を、ソースの文面で固定する。
// mainはWindmillの変数・リソースとDBとGitHubを直接使うためである。
// 判定そのものは`tests/lib/implement_finish_profile.test.ts`が確かめる。
// 整形や変数名の変更で落ちたときは、結線が変わっていないかを確かめてから文面を直す。

import { describe, expect, test } from "bun:test";

/** コメントを除いたソース。コメントに書いた呼び出しの名前を、結線として数えないため。 */
async function source(): Promise<string> {
  const text = await Bun.file(
    new URL("../../f/factory/steps/implement_finish.ts", import.meta.url),
  ).text();
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** `needle`が最初に現れる位置。無ければ-1を返す。 */
function indexOf(text: string, needle: string): number {
  return text.indexOf(needle);
}

const REROUTE_BRANCH =
  'if (action.kind === "requirements_gap" || protectedReroute !== null) {';

/** 差し戻しの分岐の本体。次の分岐(設計の不足)の手前までを返す。 */
async function rerouteBranch(): Promise<string> {
  const text = await source();
  const start = indexOf(text, REROUTE_BRANCH);
  const end = indexOf(text, 'if (action.kind === "design_gap") {');
  if (start < 0 || end < start)
    throw new Error("the reroute branch was not found");
  return text.slice(start, end);
}

describe("the protected path reroute in implement_finish", () => {
  test("decides only for a run that would open a pull request", async () => {
    expect(await source()).toMatch(
      /const protectedReroute =\s*action\.kind === "open_pr"\s*\?\s*decideProtectedPathReroute\(/,
    );
  });

  test("decides from the kind of the specification and the protected changes of the loop", async () => {
    expect(await source()).toMatch(
      /decideProtectedPathReroute\(\{\s*specKind: implementContextSpecKind\(context\),\s*protectedChanges: loop_result\.protected_changes,\s*\}\)/,
    );
  });

  test("shares the branch of the requirements gap", async () => {
    expect(await source()).toContain(REROUTE_BRANCH);
  });

  test("reports the protected change as the gap", async () => {
    expect(await rerouteBranch()).toContain(
      'protectedReroute?.gapReport ?? loop_result.gap_report ?? ""',
    );
  });

  test("decides before the pull request is opened", async () => {
    const text = await source();
    const decided = indexOf(text, "decideProtectedPathReroute(");
    const opened = indexOf(text, "const openPullRequest = async");
    expect(decided >= 0 && opened >= 0 && decided < opened).toBe(true);
  });

  test("reroutes before the first commit and push of the pull request", async () => {
    const text = await source();
    const branch = indexOf(text, REROUTE_BRANCH);
    const opened = indexOf(text, "const openPullRequest = async");
    const push = indexOf(text.slice(opened), "await commitAndPush(");
    expect(branch >= 0 && opened > branch && push > 0).toBe(true);
  });

  test.each([
    "commitAndPush(",
    "createPullRequest(",
    "updatePullRequest(",
    "preserveWork(",
    "addLabels(",
    "setWorkItemPrUrl(",
    "openPullRequest(",
  ])("does not call %s in the branch", async (call) => {
    expect(await rerouteBranch()).not.toContain(call);
  });

  test("moves the work item with the limit of the reroute", async () => {
    expect(await rerouteBranch()).toContain(
      "decideGapReroute(attempt, config.max_attempts)",
    );
  });

  test("moves the work item with the helper that sets the profile to standard", async () => {
    expect(await rerouteBranch()).toMatch(
      /updateStatusToRequirementsIfLeaseHolder\(\s*work_item_id,\s*"implementing",\s*leaseJobId,/,
    );
  });
});

describe("the comment of the switch in implement_finish", () => {
  test("hands the profile read before the switch", async () => {
    expect(await rerouteBranch()).toContain(
      "previousProfile: workItem.profile,",
    );
  });

  test("names the cause of the switch", async () => {
    expect(await rerouteBranch()).toMatch(
      /cause:\s*protectedReroute !== null \? "protected_paths" : "requirements_gap",/,
    );
  });

  test("comments after the move and before the requirements are started", async () => {
    const branch = await rerouteBranch();
    const moved = indexOf(branch, "updateStatusToRequirementsIfLeaseHolder(");
    const commented = indexOf(branch, "postProfileUpgradedComment(");
    const started = indexOf(branch, "wmill.runFlowAsync(");
    expect(moved < commented && commented < started).toBe(true);
  });

  test("posts the comment with the marker of the work item", async () => {
    expect(await rerouteBranch()).toMatch(
      /commentIssue\(\s*client,\s*owner,\s*repo,\s*issueNumber,\s*kind,\s*work_item_id,\s*body,/,
    );
  });
});

describe("the partial push in implement_finish", () => {
  test("pushes the partial work in one place only", async () => {
    const text = await source();
    expect(text.split("preserveWork(preserveWorkDeps(").length - 1).toBe(1);
  });

  test("withholds the partial work that touches a protected path of the issue specification", async () => {
    expect(await source()).toMatch(
      /shouldWithholdPartialPush\(\{\s*specKind: implementContextSpecKind\(ctx\),\s*protectedChanges: loop_result\?\.protected_changes \?\? \[\],\s*\}\)/,
    );
  });

  test("notes the withheld work with the fixed reason", async () => {
    expect(await source()).toContain("[PROTECTED_WORK_NOT_PUSHED_REASON]");
  });
});

describe("the pull request body in implement_finish", () => {
  test("hands the specification of the context", async () => {
    expect(await source()).toContain("spec: prBodySpecFor(ctx),");
  });

  test("hands the warnings of the diff for the issue specification", async () => {
    expect(await source()).toMatch(
      /profileWarnings:\s*implementContextSpecKind\(ctx\) === "issue"\s*\?\s*profileDiffWarnings\(ctx\.profile, loop\.changed_paths\)\s*:\s*\[\],/,
    );
  });
});

describe("the check of the staged tree before the partial push in implement_finish", () => {
  test("classifies the staged changes after it compares the staged tree with the scanned one", async () => {
    expect(await source()).toMatch(
      /inspectStaged: async \(\) => \{\s*const changed = await scannedTreeStopReasons\(\{[^}]*\}\);\s*if \(changed\.length > 0\) return changed;\s*return protectedPartialPushStopReasons\(\{/,
    );
  });

  test("classifies the issue specification against the base of the branch", async () => {
    expect(await source()).toMatch(
      /protectedPartialPushStopReasons\(\{\s*specKind: implementContextSpecKind\(ctx\),\s*listStagedChanges: \(\) =>\s*listChangedPaths\(\s*runCommand,\s*ctx\.worktree_dir,\s*ctx\.base_sha,?\s*\),?\s*\}\)/,
    );
  });
});
