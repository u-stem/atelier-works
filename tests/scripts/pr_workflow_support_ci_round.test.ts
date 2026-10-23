// CI回の止める理由を、人が読む文と次の操作にする規則のテスト。

import { describe, expect, test } from "bun:test";
import {
  CI_ROUND_REPLIES_REASON,
  ciClaudeFailureText,
  ciRoundApplyTimeoutMisfit,
} from "../../f/factory/lib/ci_fix_round.ts";
import { CI_ROUND_REHASH_STALE_REASON } from "../../f/factory/lib/ci_metadata_rehash.ts";
import { prCiFixHoldInfo } from "../../f/factory/lib/pr_ci_support.ts";
import {
  describeReason,
  nextActionFor,
  nextActionForPrFix,
} from "../../f/factory/steps/pr_workflow_support.ts";

const NEXT_ACTION =
  "原因を確かめて人が直してから、PRにpushしてください。headが変わると、Factoryが新しい失敗として判定し直します";
const PUSH =
  "PRにpushしてください。headが変わると、Factoryが新しい失敗として判定し直します";
const WAIT =
  "保留が解けるまで待つか、PRにpushしてください。headが変わると、Factoryが新しい失敗として判定し直します";

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
  test("gives the action of the hold reason for a fixed reason of the gather step", () => {
    expect(nextActionFor("ci round: the CI job log is unavailable")).toBe(
      prCiFixHoldInfo("log_unavailable").stopAction,
    );
  });

  test("gives the action of the hold reason for a missing skill marker", () => {
    expect(
      nextActionFor(
        "ci round: the factory-fix skill lacks the ci-fix-skill:v1 marker",
      ),
    ).toBe(prCiFixHoldInfo("marker_missing").stopAction);
  });

  test("gives the action of the hold reason for a job that cannot be fixed", () => {
    expect(
      nextActionFor(
        "ci round: the failed CI job cannot be fixed by editing the source (unnamed_job)",
      ),
    ).toBe(prCiFixHoldInfo("unfixable_job").stopAction);
  });

  test("gives the action of the hold reason for a lock that cannot be recomputed", () => {
    expect(
      nextActionFor(
        "ci round: the lock cannot be recomputed automatically (dependency_changed)",
      ),
    ).toBe(prCiFixHoldInfo("metadata_manual").stopAction);
  });

  test("gives the action of the hold reason for a lock that cannot be recomputed in a CI round", () => {
    expect(
      nextActionForPrFix(
        "ci round: the lock cannot be recomputed automatically (head_lacks_base)",
        true,
      ),
    ).toBe(prCiFixHoldInfo("metadata_manual").stopAction);
  });

  test("gives the action of the hold reason when the base branch moved before a push", () => {
    expect(nextActionFor(CI_ROUND_REHASH_STALE_REASON)).toBe(
      prCiFixHoldInfo("metadata_manual").stopAction,
    );
  });

  test("describes a lock that cannot be recomputed as a stopped CI round", () => {
    expect(
      describeReason(
        "ci round: the lock cannot be recomputed automatically (dependency_changed)",
      ),
    ).toContain("CIの失敗を直す回を止めました");
  });

  test("gives the action of the hold reason for another conclusion", () => {
    expect(
      nextActionFor(
        "ci round: the CI job did not fail but ended with cancelled",
      ),
    ).toBe(prCiFixHoldInfo("other_conclusion").stopAction);
  });

  test("gives the action of the hold reason for a log the token cannot read", () => {
    expect(
      nextActionFor("ci round: the token cannot read the CI job log"),
    ).toBe(prCiFixHoldInfo("log_unavailable").stopAction);
  });

  test("gives the action of the hold reason in a CI round of the pr_fix flow", () => {
    expect(
      nextActionForPrFix("ci round: the CI job log is unavailable", true),
    ).toBe(prCiFixHoldInfo("log_unavailable").stopAction);
  });

  test("tells the CI round time settings to be reduced, and that the restart is automatic", () => {
    expect(
      nextActionForPrFix(ciRoundApplyTimeoutMisfit(10_000, 7_200) ?? "", true),
    ).toBe(
      "claude_timeout_secか検査コマンド(allowed_check_commands)の数を減らしてください。直すと、Factoryが次の巡回で自動で起動し直します",
    );
  });

  test("tells the pr_fix time settings to be reduced in a CI round, without a push", () => {
    expect(
      nextActionForPrFix(
        "pr_fix time settings do not fit the flow step timeout: x",
        true,
      ),
    ).toBe(
      "claude_timeout_secか検査コマンド(allowed_check_commands)の数を減らしてください。直すと、Factoryが次の巡回で自動で起動し直します",
    );
  });

  test("tells a repository outside the allow list to be fixed, then restarted by itself or by a push after 24 hours, in a CI round", () => {
    expect(
      nextActionForPrFix(
        "repository is not allowed by factory_config (owners / repo_allowlist)",
        true,
      ),
    ).toBe(
      "factory_configのowners / repo_allowlistを見直してください。直すと、Factoryが次の巡回で自動で起動し直します。最初に失敗を見てから24時間たった行は閉じるので、そのときはPRにpushしてください",
    );
  });

  test("keeps the main wording for a repository outside the allow list in a normal round", () => {
    expect(
      nextActionForPrFix(
        "repository is not allowed by factory_config (owners / repo_allowlist)",
        false,
      ),
    ).toBe("factory_configのowners / repo_allowlistを見直してください");
  });

  test("keeps the main wording for a repository outside the allow list without a flow", () => {
    expect(
      nextActionFor(
        "repository is not allowed by factory_config (owners / repo_allowlist)",
      ),
    ).toBe("factory_configのowners / repo_allowlistを見直してください");
  });

  test("keeps the main wording for a repository outside the allow list in the implement flow", () => {
    expect(
      nextActionFor(
        "repository is not allowed by factory_config (owners / repo_allowlist)",
        "implement",
      ),
    ).toBe("factory_configのowners / repo_allowlistを見直してください");
  });

  test("does not give the action of a hold reason that Claude repeats", () => {
    expect(
      nextActionFor(
        "ci round: claude blocked: the CI job log is unavailable",
        "pr_fix",
      ),
    ).toBe(NEXT_ACTION);
  });

  test("uses the same action for a change that is not allowed", () => {
    expect(
      nextActionFor("ci round change not allowed (symlink): a", "pr_fix"),
    ).toBe(NEXT_ACTION);
  });

  test("tells how to deal with a test whose lines the round could not check", () => {
    expect(
      nextActionFor(
        "ci round change not allowed (test_base_unknown): tests/a.test.ts",
        "pr_fix",
      ),
    ).toBe(
      `PRが既定のブランチを向いているかと、テストの差分が大きすぎないかを確かめ、人が直してから、${PUSH}`,
    );
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

  test("asks for a push when a CI round ends with an unknown reason", () => {
    expect(nextActionForPrFix("unknown failure", true)).toBe(NEXT_ACTION);
  });

  test("asks for a push when a CI round has nothing to commit", () => {
    expect(nextActionForPrFix("no changes to commit", true)).toBe(NEXT_ACTION);
  });

  test("keeps the procedure of a draft pull request and waits for the hold to clear", () => {
    expect(nextActionForPrFix("pull request is a draft", true)).toBe(
      `ドラフトを解除してから、${WAIT}`,
    );
  });

  test("asks for a push when the PR head moved during the fix", () => {
    expect(
      nextActionForPrFix(
        "PR head moved to abc123 while the fix was in progress",
        true,
      ),
    ).toBe(NEXT_ACTION);
  });

  test("asks for a push when the worktree git pointer was not recorded", () => {
    expect(
      nextActionForPrFix("worktree git pointer was not recorded", true),
    ).toBe(NEXT_ACTION);
  });

  test("asks for a push when the PR head was not recorded", () => {
    expect(nextActionForPrFix("PR head was not recorded", true)).toBe(
      NEXT_ACTION,
    );
  });

  test("asks for a push when Claude blocked with a reason that points to a retry", () => {
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
      `理由に載ったプロセスが終わるのを待つか、workerのコンテナでそのプロセスを止めてから、${PUSH}`,
    );
  });

  test("keeps the review-round action of a busy worktree", () => {
    expect(nextActionForPrFix(BUSY, false)).toBe(nextActionFor(BUSY, "pr_fix"));
  });

  test("keeps the procedure of a failed ownership restore", () => {
    expect(nextActionForPrFix(OWNERSHIP, true)).toBe(
      `運用の文書(docs/operations.md)の「検査の枠の記録を片付ける」の手順で、枠の記録が指すworktreeをrootに戻して記録を消してから、${PUSH}`,
    );
  });

  test("keeps the review-round action of a failed ownership restore", () => {
    expect(nextActionForPrFix(OWNERSHIP, false)).toBe(
      nextActionFor(OWNERSHIP, "pr_fix"),
    );
  });

  test("keeps the procedure of a stale worker image", () => {
    expect(nextActionForPrFix(STALE_IMAGE, true)).toBe(
      `ホストのcheckoutでgit pullし、mise installとmise run upでworkerのイメージを作り直してください。作り直した後、失敗の行は止まってから24時間後に保留なしで戻ります。待てないときは、${PUSH}`,
    );
  });

  test("does not promise an automatic re-evaluation for a stale worker image", () => {
    expect(nextActionForPrFix(STALE_IMAGE, true)).not.toContain(
      "自動で評価し直",
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
      `検査コマンドが常駐プロセスを残していないか確かめ、残っていればworkerのコンテナで止めてから、${PUSH}`,
    );
  });

  test("keeps the review-round action of a lock held by a process of the run", () => {
    expect(nextActionForPrFix(LOCK_HELD, false)).toBe(
      nextActionFor(LOCK_HELD, "pr_fix"),
    );
  });

  test("keeps the procedure of a moved local HEAD", () => {
    expect(nextActionForPrFix("local HEAD a is not the PR head b", true)).toBe(
      `検査コマンドがコミットやブランチの切り替えをしていないか確かめて人が直してから、${PUSH}`,
    );
  });

  test("keeps the procedure of a changed worktree after the secret scan", () => {
    expect(
      nextActionForPrFix("worktree changed after the secret scan", true),
    ).toBe(
      `検査コマンドなどが残したプロセスがworktreeを書き換えていないか確かめ、${PUSH}`,
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

describe("nextActionForPrFix keeps the procedure of a gate reason in a CI round", () => {
  test("does not promise an automatic re-evaluation for a draft pull request", () => {
    expect(nextActionForPrFix("pull request is a draft", true)).not.toContain(
      "自動で評価し直",
    );
  });

  test("keeps the procedure of auto-merge and waits for the hold to clear", () => {
    expect(
      nextActionForPrFix("pull request has auto-merge enabled", true),
    ).toBe(`PRのauto-mergeを無効にしてから、${WAIT}`);
  });

  test("keeps the review-round action of auto-merge", () => {
    expect(
      nextActionForPrFix("pull request has auto-merge enabled", false),
    ).toBe(
      "PRのauto-mergeを無効にしてから、あらためて`factory:fix`ラベルを付けてください",
    );
  });

  test("keeps the procedure of a diff that has too many files", () => {
    expect(
      nextActionForPrFix("changed file count 31 exceeds max_files 30", true),
    ).toBe(`変更を分割するか、上限を見直してから、${PUSH}`);
  });

  test("keeps the procedure of a diff that has too many lines", () => {
    expect(
      nextActionForPrFix("diff line total 900 exceeds max_lines 800", true),
    ).toBe(`変更を分割するか、上限を見直してから、${PUSH}`);
  });

  test("keeps the procedure of the generic safety guard reason", () => {
    expect(nextActionForPrFix("safety guard failed", true)).toBe(
      `通知の理由とConsoleのシステム画面で原因を確かめ、取り除いてから、${PUSH}`,
    );
  });

  test("keeps the procedure of the generic human attention reason", () => {
    expect(nextActionForPrFix("needs human attention", true)).toBe(
      `通知の理由とConsoleのシステム画面で原因を確かめ、取り除いてから、${PUSH}`,
    );
  });
});

describe("a blocked reason of Claude in a CI round", () => {
  const HIJACK =
    "ci round: claude blocked: worker runtime is unsafe for checks: chmod o-w the paths or recreate windmill_worker: /x";

  test("does not lead to the procedure of an infrastructure reason", () => {
    expect(nextActionForPrFix(HIJACK, true)).toBe(NEXT_ACTION);
  });

  test("describes the reason as a stopped CI round", () => {
    expect(
      describeReason("ci round: claude blocked: 原因が分かりません。"),
    ).toBe(
      "CIの失敗を直す回を止めました(claude blocked: 原因が分かりません。)",
    );
  });
});
