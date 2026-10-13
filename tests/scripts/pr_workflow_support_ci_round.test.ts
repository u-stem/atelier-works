// CI回の止める理由を、人が読む文と次の操作にする規則のテスト。

import { describe, expect, test } from "bun:test";
import {
  CI_ROUND_REPLIES_REASON,
  ciClaudeFailureText,
} from "../../f/factory/lib/ci_fix_round.ts";
import {
  describeReason,
  nextActionFor,
  nextActionForPrFix,
} from "../../f/factory/steps/pr_workflow_support.ts";

const NEXT_ACTION =
  "CIの再評価を待ってください。直らなければ、人が修正してください";

describe("describeReason for a CI round", () => {
  test("describes a fixed reason of the gather step", () => {
    expect(describeReason("ci round: the CI job log is unavailable")).toBe(
      "CIの失敗を直す回を止めました(the CI job log is unavailable)",
    );
  });

  test("describes a failed run of Claude", () => {
    expect(describeReason(ciClaudeFailureText("timeout"))).toBe(
      "CIの失敗を直す回を止めました(claude run failed (timeout))",
    );
  });

  test("describes a reason with replies", () => {
    expect(describeReason(CI_ROUND_REPLIES_REASON)).toBe(
      "CIの失敗を直す回を止めました(the output of Claude carries replies)",
    );
  });

  test("describes a change that is not allowed", () => {
    expect(
      describeReason(
        "ci round change not allowed (protected_path): .github/workflows/ci.yml",
      ),
    ).toBe(
      "CIの失敗を直す回を止めました(change not allowed (protected_path): .github/workflows/ci.yml)",
    );
  });

  test("describes every item of a joined list", () => {
    expect(
      describeReason(
        "ci round change not allowed (symlink): a; ci round change not allowed (protected_path): b",
      ),
    ).toBe(
      "CIの失敗を直す回を止めました(change not allowed (symlink): a); CIの失敗を直す回を止めました(change not allowed (protected_path): b)",
    );
  });

  test("leaves a reason that only mentions the prefix in the middle", () => {
    expect(describeReason("not a ci round: x")).toBe("not a ci round: x");
  });
});

describe("nextActionFor a CI round", () => {
  test("waits for the re-evaluation instead of a retry", () => {
    expect(nextActionFor("ci round: the CI job log is unavailable")).toBe(
      NEXT_ACTION,
    );
  });

  test("uses the same action for a change that is not allowed", () => {
    expect(
      nextActionFor("ci round change not allowed (symlink): a", "pr_fix"),
    ).toBe(NEXT_ACTION);
  });

  test("does not point to retry_work_item", () => {
    expect(nextActionFor("ci round: x", "pr_fix")).not.toContain(
      "retry_work_item",
    );
  });
});

describe("nextActionForPrFix", () => {
  test("keeps the generic action of a review round", () => {
    expect(nextActionForPrFix("unknown failure", false)).toBe(
      nextActionFor("unknown failure", "pr_fix"),
    );
  });

  test("waits for the re-evaluation when a CI round ends with an unknown reason", () => {
    expect(nextActionForPrFix("unknown failure", true)).toBe(NEXT_ACTION);
  });

  test("waits for the re-evaluation when a CI round has nothing to commit", () => {
    expect(nextActionForPrFix("no changes to commit", true)).toBe(NEXT_ACTION);
  });

  test("keeps the procedure of a draft pull request and waits for the re-evaluation", () => {
    expect(nextActionForPrFix("pull request is a draft", true)).toBe(
      "ドラフトを解除してから、CIの再評価を待ってください",
    );
  });

  test("waits for the re-evaluation when the PR head moved during the fix", () => {
    expect(
      nextActionForPrFix(
        "PR head moved to abc123 while the fix was in progress",
        true,
      ),
    ).toBe(NEXT_ACTION);
  });

  test("waits for the re-evaluation when the worktree git pointer was not recorded", () => {
    expect(
      nextActionForPrFix("worktree git pointer was not recorded", true),
    ).toBe(NEXT_ACTION);
  });

  test("waits for the re-evaluation when the PR head was not recorded", () => {
    expect(nextActionForPrFix("PR head was not recorded", true)).toBe(
      NEXT_ACTION,
    );
  });

  test("waits for the re-evaluation when Claude blocked with a reason that points to a retry", () => {
    expect(nextActionForPrFix("head branch state is unavailable", true)).toBe(
      NEXT_ACTION,
    );
  });

  test("keeps the draft action of a review round", () => {
    expect(nextActionForPrFix("pull request is a draft", false)).toBe(
      nextActionFor("pull request is a draft", "pr_fix"),
    );
  });

  test("keeps a specific action that points to neither a retry nor a relabel", () => {
    expect(nextActionForPrFix("pull request is not open", true)).toBe(
      nextActionFor("pull request is not open", "pr_fix"),
    );
  });
});

describe("nextActionForPrFix keeps the procedure of an infrastructure reason in a CI round", () => {
  const BUSY = "worktree is still used by processes from an earlier run: 123";
  const OWNERSHIP =
    "worktree is still used by processes from an earlier run: check sandbox: acl left";
  const STALE_IMAGE = "worker image is stale: run mise run up: version 1";
  const LOCK_HELD = "worktree lock is held by a process this run left behind";

  test("keeps the procedure of a busy worktree", () => {
    expect(nextActionForPrFix(BUSY, true)).toBe(
      "理由に載ったプロセスが終わるのを待つか、workerのコンテナでそのプロセスを止めてから、CIの再評価を待ってください",
    );
  });

  test("keeps the review-round action of a busy worktree", () => {
    expect(nextActionForPrFix(BUSY, false)).toBe(nextActionFor(BUSY, "pr_fix"));
  });

  test("keeps the procedure of a failed ownership restore", () => {
    expect(nextActionForPrFix(OWNERSHIP, true)).toBe(
      "運用の文書(docs/operations.md)の「検査の枠の記録を片付ける」の手順で、枠の記録が指すworktreeをrootに戻して記録を消してから、CIの再評価を待ってください",
    );
  });

  test("keeps the review-round action of a failed ownership restore", () => {
    expect(nextActionForPrFix(OWNERSHIP, false)).toBe(
      nextActionFor(OWNERSHIP, "pr_fix"),
    );
  });

  test("keeps the procedure of a stale worker image", () => {
    expect(nextActionForPrFix(STALE_IMAGE, true)).toBe(
      "ホストのcheckoutでgit pullし、mise installとmise run upでworkerのイメージを作り直してください。作り直した後は、CIの再評価を待ってください",
    );
  });

  test("does not say that a stalled item resumes by itself for a stale worker image", () => {
    expect(nextActionForPrFix(STALE_IMAGE, true)).not.toContain("自動で再開");
  });

  test("keeps the review-round action of a stale worker image", () => {
    expect(nextActionForPrFix(STALE_IMAGE, false)).toBe(
      nextActionFor(STALE_IMAGE, "pr_fix"),
    );
  });

  test("keeps the procedure of a lock held by a process of the run", () => {
    expect(nextActionForPrFix(LOCK_HELD, true)).toBe(
      "検査コマンドが常駐プロセスを残していないか確かめ、残っていればworkerのコンテナで止めてから、CIの再評価を待ってください",
    );
  });

  test("keeps the review-round action of a lock held by a process of the run", () => {
    expect(nextActionForPrFix(LOCK_HELD, false)).toBe(
      nextActionFor(LOCK_HELD, "pr_fix"),
    );
  });

  test("keeps the procedure of a moved local HEAD", () => {
    expect(nextActionForPrFix("local HEAD a is not the PR head b", true)).toBe(
      "検査コマンドがコミットやブランチの切り替えをしていないか確かめて人が直してから、CIの再評価を待ってください",
    );
  });

  test("keeps the procedure of a changed worktree after the secret scan", () => {
    expect(
      nextActionForPrFix("worktree changed after the secret scan", true),
    ).toBe(
      "検査コマンドなどが残したプロセスがworktreeを書き換えていないか確かめ、CIの再評価を待ってください",
    );
  });

  test("keeps the procedure of an unsafe worker runtime without a retry", () => {
    expect(
      nextActionForPrFix(
        "worker runtime is unsafe for checks: chmod o-w the paths or recreate windmill_worker: /x",
        true,
      ),
    ).not.toContain("retry_work_item");
  });
});
