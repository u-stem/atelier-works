// 各準備のステップが、リポジトリを取得する前にオーナーの数値IDを照合していることのテスト。
// 各ステップのmainはWindmillとDBを直接使うので、呼ぶ順をソースの並びで確かめる。
// 照合の判定そのものは`tests/lib/repo_owner_gate.test.ts`が確かめる。

import { describe, expect, test } from "bun:test";

const STEPS_DIR = new URL("../../f/factory/steps/", import.meta.url);

async function source(name: string): Promise<string> {
  return Bun.file(new URL(name, STEPS_DIR)).text();
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
      positionOf(text, "implementCheckCommandsFor(\n"),
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
    expect(text).toContain("checkRepoOwner: () =>\n        verifyRepoOwnerId(");
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
