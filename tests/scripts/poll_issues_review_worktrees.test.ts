// `poll_issues.ts`のPRが閉じたときの片付けが、レビュー用の作業ツリーの選び方と消し方を、
// 定期の片付けと同じ関数(`selectReviewWorktreesOfPr`、`reviewWorktreeRemoval`)で行うことを確かめる。
// `removePrWorktrees`は`/workspaces`の固定のパスを読むので、ソースの形で固定する。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(
  join(import.meta.dir, "../../f/factory/poll_issues.ts"),
  "utf8",
);

describe("poll_issues review worktree removal", () => {
  test("selects the worktrees with the shared function", () => {
    expect(SOURCE).toContain("selectReviewWorktreesOfPr(");
  });

  test("does not check the name form itself", () => {
    expect(SOURCE).not.toContain("isReviewWorktreeOf(");
  });

  test("decides how to remove a locked worktree with the shared function", () => {
    expect(SOURCE).toContain("reviewWorktreeRemoval(");
  });
});
