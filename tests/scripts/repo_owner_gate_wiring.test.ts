// 各準備のステップが、リポジトリを取得する前にオーナーの数値IDを照合していることのテスト。
// 各ステップのmainはWindmillとDBを直接使うので、呼ぶ順をソースの並びで確かめる。
// 照合の判定そのものは`tests/lib/repo_owner_gate.test.ts`が確かめる。

import { describe, expect, test } from "bun:test";

const STEPS_DIR = new URL("../../f/factory/steps/", import.meta.url);

async function source(name: string): Promise<string> {
  return Bun.file(new URL(name, STEPS_DIR)).text();
}

/**
 * `marker`を含む行の次の行から、コメント行と空行を除いた文の行を順に返す。
 * 呼び出しが「その行の直後の文」であることを、行の位置でなく並びで確かめるために使う。
 */
function statementsAfter(
  text: string,
  marker: string,
  count: number,
): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.includes(marker));
  if (start === -1) throw new Error(`not found in the source: ${marker}`);
  return lines
    .slice(start + 1)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("//"))
    .slice(0, count);
}

/** `needle`が最初に現れる位置。無ければ例外にして、テストの前提が崩れたことを知らせる。 */
function positionOf(text: string, needle: string): number {
  const position = text.indexOf(needle);
  if (position === -1) throw new Error(`not found in the source: ${needle}`);
  return position;
}

describe("the owner id check in implement_prepare", () => {
  test("runs before the factory clone is opened", async () => {
    const text = await source("implement_prepare.ts");
    expect(positionOf(text, "await verifyRepoOwnerId(")).toBeLessThan(
      positionOf(text, "await openFactoryClone("),
    );
  });

  test("runs before the target repository is cloned", async () => {
    const text = await source("implement_prepare.ts");
    expect(positionOf(text, "await verifyRepoOwnerId(")).toBeLessThan(
      positionOf(text, "await ensureRepo("),
    );
  });

  test("runs before the check commands of the repository are read", async () => {
    const text = await source("implement_prepare.ts");
    expect(positionOf(text, "await verifyRepoOwnerId(")).toBeLessThan(
      positionOf(text, "= implementCheckCommandsFor("),
    );
  });
});

describe("the owner id check in pr_fix_prepare", () => {
  test("runs before the factory clone is opened", async () => {
    const text = await source("pr_fix_prepare.ts");
    expect(positionOf(text, "await verifyRepoOwnerId(")).toBeLessThan(
      positionOf(text, "await openFactoryClone("),
    );
  });

  test("runs before the target repository is cloned", async () => {
    const text = await source("pr_fix_prepare.ts");
    expect(positionOf(text, "await verifyRepoOwnerId(")).toBeLessThan(
      positionOf(text, "await ensureRepo("),
    );
  });

  test("runs before the pull request is read", async () => {
    const text = await source("pr_fix_prepare.ts");
    expect(positionOf(text, "await verifyRepoOwnerId(")).toBeLessThan(
      positionOf(text, "await getPr("),
    );
  });
});

describe("the owner id check in pipeline_prepare", () => {
  test("runs before the factory clone is opened", async () => {
    const text = await source("pipeline_prepare.ts");
    expect(positionOf(text, "await verifyRepoOwnerId(")).toBeLessThan(
      positionOf(text, "await openFactoryClone("),
    );
  });

  test("runs before the target repository is cloned", async () => {
    const text = await source("pipeline_prepare.ts");
    expect(positionOf(text, "await verifyRepoOwnerId(")).toBeLessThan(
      positionOf(text, "await ensureRepo("),
    );
  });
});

describe("the owner id check in pr_review_prepare", () => {
  test("is handed to the worktree preparation, which runs it first", async () => {
    const text = await source("pr_review_prepare.ts");
    expect(positionOf(text, "checkRepoOwner:")).toBeLessThan(
      positionOf(text, "verifyRepoOwnerId("),
    );
  });
});

describe("the owner id check in manual_intake_create_issue", () => {
  test("runs before the issue is created", async () => {
    const text = await source("manual_intake_create_issue.ts");
    expect(positionOf(text, "await verifyRepoOwnerId(")).toBeLessThan(
      positionOf(text, "await createIssue("),
    );
  });
});

describe("the owner check in issue_proposal_apply", () => {
  test("is the first statement of the approval path, before any record or write", async () => {
    const text = await source("issue_proposal_apply.ts");
    expect(statementsAfter(text, 'if (decision === "approve") {', 2)).toEqual([
      "await ensureProposalRepoOwner(verifyOwner);",
      "await decideIssueProposal(proposal_id, {",
    ]);
  });

  test("follows the recording of a rejection and guards the reply on the rejection path", async () => {
    const text = await source("issue_proposal_apply.ts");
    expect(statementsAfter(text, 'status: "rejected",', 9)).toEqual([
      "decided_by: decidedBy,",
      "decision_reason: reason,",
      "with_factory_label: null,",
      "created_issue_number: null,",
      "created_issue_url: null,",
      "});",
      'if (proposal.origin === "pr_fix") {',
      "const stop = await rejectionReplyStop(verifyOwner);",
      "if (stop === null) {",
    ]);
  });

  test("posts the rejection reply only inside the passing branch", async () => {
    const text = await source("issue_proposal_apply.ts");
    expect(statementsAfter(text, "if (stop === null) {", 12)).toContain(
      "await postDecisionReply(proposal, prNumber, replyBody);",
    );
  });

  test("builds the check from one call to the gate", async () => {
    const text = await source("issue_proposal_apply.ts");
    expect(text.split("verifyRepoOwnerId(").length - 1).toBe(1);
  });

  test("calls the approval check once", async () => {
    const text = await source("issue_proposal_apply.ts");
    expect(text.split("await ensureProposalRepoOwner(").length - 1).toBe(1);
  });

  test("calls the rejection check once", async () => {
    const text = await source("issue_proposal_apply.ts");
    expect(text.split("await rejectionReplyStop(verifyOwner)").length - 1).toBe(
      1,
    );
  });
});

describe("the owner id check before the writes of the finish steps", () => {
  test("implement_finish checks before the final commit and push", async () => {
    const text = await source("implement_finish.ts");
    expect(positionOf(text, "await ownerStopReason()")).toBeLessThan(
      positionOf(text, "const pushed = await commitAndPush("),
    );
  });

  test("implement_finish hands the check to the partial work push", async () => {
    const text = await source("implement_finish.ts");
    expect(text).toContain("ensureRepoOwner: ownerStopReason,");
  });

  test("implement_finish checks before deleting the remote branch", async () => {
    const text = await source("implement_finish.ts");
    expect(positionOf(text, "await ownerStopReason()")).toBeLessThan(
      positionOf(text, "await deleteRemoteBranch("),
    );
  });

  test("pr_fix_finish checks before the commit and push", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(positionOf(text, "await repoOwnerStopReason(")).toBeLessThan(
      positionOf(text, "pushResult = await commitAndPush("),
    );
  });

  test("pr_fix_finish checks after the pull request is read for the ci round", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(
      positionOf(text, "await getPr(client, owner, repo, pr_number)"),
    ).toBeLessThan(positionOf(text, "await repoOwnerStopReason("));
  });

  test("pr_fix_finish calls the gate once", async () => {
    const text = await source("pr_fix_finish.ts");
    expect(text.split("await repoOwnerStopReason(").length - 1).toBe(1);
  });

  test("pr_review_post hands the check to the review publication", async () => {
    const text = await source("pr_review_post.ts");
    expect(text).toContain("ensureRepoOwner: () =>");
  });

  test("drawio_viewer_bump hands the factory_repo_id check to the bump", async () => {
    const text = await Bun.file(
      new URL("../../f/factory/drawio_viewer_bump.ts", import.meta.url),
    ).text();
    expect(text).toContain("verifyFactoryRepo: async () =>");
  });
});
