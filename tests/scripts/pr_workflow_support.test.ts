import { describe, expect, test } from "bun:test";
import {
  CI_ROUND_REPLIES_REASON,
  ciClaudeFailureText,
  ciRoundApplyTimeoutMisfit,
} from "../../f/factory/lib/ci_fix_round.ts";
import { CI_ROUND_REHASH_STALE_REASON } from "../../f/factory/lib/ci_metadata_rehash.ts";
import {
  DEPENDABOT_DRY_RUN_REASON,
  DEPENDABOT_MERGE_FORBIDDEN_REASON,
  DEPENDABOT_MERGE_HELD_REASON,
  DEPENDABOT_MERGE_REFUSED_REASON,
  DEPENDABOT_RESULT_UNKNOWN_REASON,
  DEPENDABOT_TIMEOUT_MISFIT_REASON,
  dependabotHoldUnreadableReason,
  dependabotReason,
} from "../../f/factory/lib/dependabot_flow_support.ts";
import {
  hasMarker,
  isFactoryPost,
  type ReviewThread,
  withMarker,
} from "../../f/factory/lib/github.ts";
import { prCiFixHoldInfo } from "../../f/factory/lib/pr_ci_support.ts";
import {
  factoryRepoIdCheckReason,
  repoOwnerIdMismatchReason,
  repoOwnerNotConfiguredReason,
  repoOwnerNotFoundReason,
} from "../../f/factory/lib/repo_owner_gate.ts";
import type { FixReply } from "../../f/factory/lib/types.ts";
import {
  buildAuditProposalBody,
  buildIssueProposalBody,
  buildIssueProposalReason,
  buildIssueProposalTitle,
  ciRoundActionOfRule,
  conflictRoundTimeoutMisfit,
  decideFixFinishAction,
  decidePostProposalStatus,
  decidePostProposalTransition,
  describeReason,
  earlyExitBase,
  extractLinkedIssueNumbers,
  findPostedReviewId,
  fixOutputProseIssues,
  matchReviewThreadForComment,
  nextActionFor,
  nextActionForPrFix,
  normalizeJapaneseText,
  type PostedReviewCandidate,
  PR_FIX_APPLY_STEP_TIMEOUT_SEC,
  PR_FIX_VERIFY_STEP_TIMEOUT_SEC,
  REASON_RULES,
  readWorktreeFileIfExists,
  renderIssueProposalApprovedReply,
  renderIssueProposalRejectedReply,
  reviewOutputProseIssues,
  selectProposeIssueReplies,
  withReviewMarkers,
} from "../../f/factory/steps/pr_workflow_support.ts";

// 稼働中のIssueの一意インデックスへの違反を、人が読む文にする規則のテスト。
// 承認の後の実装への移行が失敗したときに、この文が使われる。
// 現在のサイクルが別にあるので、この作業項目は再開できない。
describe("pr_workflow_support active issue", () => {
  const RAW =
    'duplicate key value violates unique constraint "work_items_active_issue_key"';

  describe("the active issue index violation", () => {
    test("is described as another cycle being active", () => {
      expect(describeReason(RAW)).toBe("同じIssueで、別のサイクルが稼働中です");
    });

    test("asks for no action and says to follow the current cycle", () => {
      expect(nextActionFor(RAW)).toBe(
        "操作は要りません。この作業項目は再開できないので、このIssueの現在のサイクルの作業項目に従ってください",
      );
    });
  });
});

// CI回の止める理由を、人が読む文と次の操作にする規則のテスト。
describe("pr_workflow_support ci round", () => {
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
        nextActionForPrFix(
          ciRoundApplyTimeoutMisfit(10_000, 7_200) ?? "",
          true,
        ),
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
      expect(nextActionForPrFix("no changes to commit", true)).toBe(
        NEXT_ACTION,
      );
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
      expect(nextActionForPrFix(BUSY, false)).toBe(
        nextActionFor(BUSY, "pr_fix"),
      );
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
      expect(
        nextActionForPrFix("local HEAD a is not the PR head b", true),
      ).toBe(
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
});

// 競合回の、pr_fixの各ステップが共有する判断のテスト。
describe("pr_workflow_support conflict round", () => {
  describe("conflictRoundTimeoutMisfit", () => {
    test("accepts the default time settings without check commands", () => {
      expect(
        conflictRoundTimeoutMisfit({
          claude_timeout_sec: 1800,
          allowed_check_commands: [],
        }),
      ).toBeNull();
    });

    test("accepts the default time settings with two check commands", () => {
      expect(
        conflictRoundTimeoutMisfit({
          claude_timeout_sec: 1800,
          allowed_check_commands: ["mise run a", "mise run b"],
        }),
      ).toBeNull();
    });

    test("stops a Claude timeout that the fix step cannot hold", () => {
      expect(
        conflictRoundTimeoutMisfit({
          claude_timeout_sec: PR_FIX_APPLY_STEP_TIMEOUT_SEC,
          allowed_check_commands: [],
        }),
      ).toContain("pr_fix time settings do not fit the flow step timeout");
    });

    test("stops a verify step that cannot hold the check commands", () => {
      const reason = conflictRoundTimeoutMisfit({
        claude_timeout_sec: 60,
        allowed_check_commands: Array.from({ length: 400 }, () => "mise run x"),
      });
      expect(reason).toContain(String(PR_FIX_VERIFY_STEP_TIMEOUT_SEC));
    });

    test("carries the conflict round prefix when only the conflict round work does not fit", () => {
      const reason = conflictRoundTimeoutMisfit({
        claude_timeout_sec: 3250,
        allowed_check_commands: [],
      });
      expect(
        reason?.startsWith("conflict round: time settings do not fit"),
      ).toBe(true);
    });
  });

  describe("decideFixFinishAction for a conflict round", () => {
    test("handles an up_to_date round on its own", () => {
      expect(decideFixFinishAction("conflict_up_to_date", false)).toEqual({
        kind: "conflict_up_to_date",
      });
    });

    test("handles a blocked round on its own", () => {
      expect(decideFixFinishAction("conflict_blocked", false)).toEqual({
        kind: "conflict_blocked",
      });
    });
  });

  describe("earlyExitBase for a conflict round", () => {
    const workItem = {
      owner: "octo-owner",
      repo: "sample-repo",
      pr_number: 3,
      head_sha: "abc1234",
      parent_work_item_id: null,
      attempt: 1,
      fix_round: 4,
      ci_check_id: null,
      conflict_check_id: 12,
    };

    test("keeps the conflict check id so that pr_fix_finish knows it is a conflict round", () => {
      expect(earlyExitBase(workItem).conflict_check_id).toBe(12);
    });

    test("records no baseline commit", () => {
      expect(earlyExitBase(workItem).baseline_sha).toBeNull();
    });

    test("records no base sha", () => {
      expect(earlyExitBase(workItem).base_sha).toBeNull();
    });

    test("records no tree of the baseline commit", () => {
      expect(earlyExitBase(workItem).auto_tree_sha).toBeNull();
    });

    test("records no conflicted paths", () => {
      expect(earlyExitBase(workItem).conflicted_paths).toBeNull();
    });

    test("records no conflict blobs", () => {
      expect(earlyExitBase(workItem).conflict_blobs).toBeNull();
    });
  });
});

// dependabotの作業項目の理由を、人が読む文にする規則のテスト。
// どの次の操作も、dependabotが拒否する`retry_work_item`を案内してはならない。
describe("pr_workflow_support dependabot", () => {
  const MANUAL_ACTION =
    "PRの内容を人が確認し、問題なければ手でマージするか閉じてください。この作業項目は再実行できません。新しいコミットが積まれると、自動で再び対象になります";
  const COMMENT_ACTION =
    "PRのコメントの所見を確認し、問題なければ手でマージするか閉じてください。この作業項目は再実行できません。新しいコミットが積まれると、自動で再び対象になります";

  const OWNER_STOP_ACTION =
    "GitHubでそのオーナーとリポジトリが意図した持ち主のものか確かめ、factory_configのownersとfactory_repo_idを見直してください。確かめるまで、このPRをマージしないでください。持ち主が変わっていたら、現在のIDを書き写さずに、そのオーナーをownersから外してください。この作業項目は再実行できません。見直した後に新しいコミットが積まれると、自動で再び対象になります";

  const OWNER_STOP_REASONS: readonly [string, string][] = [
    ["id mismatch", repoOwnerIdMismatchReason("acme/widgets", 1, 2)],
    ["not found", repoOwnerNotFoundReason("acme/widgets", 1)],
    ["not configured", repoOwnerNotConfiguredReason("acme/widgets")],
    ["factory repo id", factoryRepoIdCheckReason("acme/widgets")],
  ];

  const CASES: {
    label: string;
    reason: string;
    described: string;
    nextAction: string;
  }[] = [
    {
      label: "gate",
      reason: dependabotReason("gate", "update kind is major"),
      described:
        "dependabotの更新が、自動でマージする条件を満たしていません(update kind is major)",
      nextAction: MANUAL_ACTION,
    },
    {
      label: "collect",
      reason: dependabotReason("collect", "base branch is not main"),
      described:
        "dependabotの更新の検査に必要な情報を集められませんでした(base branch is not main)",
      nextAction: MANUAL_ACTION,
    },
    {
      label: "install failed",
      reason: dependabotReason("installFailed", "exit code 1"),
      described:
        "dependabotの更新の依存を、隔離した環境でインストールできませんでした(exit code 1)",
      nextAction: MANUAL_ACTION,
    },
    {
      label: "local check",
      reason: dependabotReason("localCheck", "repository changed"),
      described:
        "dependabotの更新を、インストールした後の確認で止めました(repository changed)",
      nextAction: MANUAL_ACTION,
    },
    {
      label: "impact with supply chain concerns",
      reason: dependabotReason(
        "impact",
        "2 supply chain concern(s) were reported",
      ),
      described:
        "dependabotの更新の影響調査で、サプライチェーンの懸念が2件報告されました",
      nextAction: COMMENT_ACTION,
    },
    {
      label: "impact with unverified items",
      reason: dependabotReason("impact", "3 unverified item(s) remain"),
      described: "dependabotの更新の影響調査で、未確認の項目が3件残っています",
      nextAction: COMMENT_ACTION,
    },
    {
      label: "impact with another detail",
      reason: dependabotReason("impact", "claude output was rejected"),
      described:
        "dependabotの更新の影響調査で、人の確認が必要と判断しました(claude output was rejected)",
      nextAction: COMMENT_ACTION,
    },
    {
      label: "assess",
      reason: dependabotReason("assess", "claude run failed (timeout)"),
      described:
        "dependabotの更新の影響調査を、最後まで行えませんでした(claude run failed (timeout))",
      nextAction: MANUAL_ACTION,
    },
    {
      label: "finish",
      reason: dependabotReason(
        "finish",
        "the pull request could not be re-read",
      ),
      described:
        "dependabotの更新を、終了の処理(マージや所見の投稿)で止めました(the pull request could not be re-read)",
      nextAction: MANUAL_ACTION,
    },
    {
      label: "poll",
      reason: dependabotReason("poll", "the flow could not be started"),
      described:
        "dependabotの更新を、PRを取得する処理で人に回しました(the flow could not be started)",
      nextAction: MANUAL_ACTION,
    },
    {
      label: "dry run",
      reason: DEPENDABOT_DRY_RUN_REASON,
      described:
        "dry run: dependabotの更新をマージ可と判定しました。試運転のため、マージしていません",
      nextAction:
        "このPRは、確認して手でマージしてください。dependabot_merge_enabledを有効にしても、このPRは再評価されません。この作業項目は再実行できません",
    },
    {
      label: "merge forbidden",
      reason: DEPENDABOT_MERGE_FORBIDDEN_REASON,
      described: "dependabotの更新をマージする権限がありませんでした(403)",
      nextAction:
        "PATのマージ権限とrulesetのbypassを確認し、手でマージしてください",
    },
    {
      label: "merge refused",
      reason: DEPENDABOT_MERGE_REFUSED_REASON,
      described: "GitHubがdependabotの更新のマージを拒否しました(405)",
      nextAction: "マージできない理由(競合や保護)を確認してください",
    },
    {
      label: "result unknown",
      reason: DEPENDABOT_RESULT_UNKNOWN_REASON,
      described: "dependabotの更新のマージ結果を確認できませんでした",
      nextAction:
        "PRがマージ済みかを確認してください。未マージなら内容を確認し、手でマージするか閉じてください。この作業項目は再実行できません",
    },
    {
      label: "merge held",
      reason: DEPENDABOT_MERGE_HELD_REASON,
      described:
        "dependabotの更新を、マージの保留があるため自動ではマージしませんでした",
      nextAction:
        "`mise run hold:list`で保留の理由と期限を確認してください。解除してよければ`mise run hold:release -- <id>`を実行し、その後PRを確認して手でマージしてください。保留を解いても、この作業項目は再開せず、再実行もできません。dependabotがrebaseして新しいコミットが積まれると、自動で再び対象になります",
    },
    {
      label: "hold table missing",
      reason: dependabotHoldUnreadableReason("missing_table"),
      described:
        "dependabotの更新を、保留の表がないため自動ではマージしませんでした(missing_table)",
      nextAction:
        "保留の表を作るmigrationが反映済みか、デプロイの記録で確認してください。その後PRを確認して手でマージしてください。この作業項目は再実行できません",
    },
    {
      label: "hold read failed",
      reason: dependabotHoldUnreadableReason("read_failed"),
      described:
        "dependabotの更新を、保留の表を読めなかったため自動ではマージしませんでした(read_failed)",
      nextAction:
        "DBが動いているか確認し、`mise run hold:list`で保留を読めるか確かめてください。その後PRを確認して手でマージしてください。この作業項目は再実行できません",
    },
    {
      label: "hold table corrupt",
      reason: dependabotHoldUnreadableReason("corrupt"),
      described:
        "dependabotの更新を、保留の表に壊れた行があるため自動ではマージしませんでした(corrupt)",
      nextAction:
        "`mise run hold:list`で壊れた行を確認し、psqlでその行を解除か削除してください。回復の手順は保留の内部仕様にあります。その後PRを確認して手でマージしてください。この作業項目は再実行できません",
    },
    {
      label: "hold read error",
      reason: dependabotHoldUnreadableReason("error"),
      described:
        "dependabotの更新を、保留の読み取りで予期しない失敗があったため自動ではマージしませんでした(error)",
      nextAction:
        "workerのログで原因を確認し、`mise run hold:list`で保留を読めるか確かめてください。その後PRを確認して手でマージしてください。この作業項目は再実行できません",
    },
    {
      label: "time settings misfit",
      reason: `${DEPENDABOT_TIMEOUT_MISFIT_REASON}: 2 claude runs x (claude_timeout_sec 9000 + 15) + 600 = 18630s exceeds 7200s`,
      described:
        "dependabotの時間設定が、flow.yamlの影響調査ステップのtimeoutに収まりません(2 claude runs x (claude_timeout_sec 9000 + 15) + 600 = 18630s exceeds 7200s)",
      nextAction:
        "claude_timeout_secを減らしてください。この作業項目は再実行できないので、PRは人が確認して手でマージするか閉じてください",
    },
  ];

  describe("describeReason for dependabot", () => {
    test.each(CASES)("describes the $label reason", ({ reason, described }) => {
      expect(describeReason(reason)).toBe(described);
    });

    test("describes a gate reason even when the detail mentions another rule", () => {
      const reason = dependabotReason("gate", "work_items_active_issue_key");

      expect(describeReason(reason)).toBe(
        "dependabotの更新が、自動でマージする条件を満たしていません(work_items_active_issue_key)",
      );
    });

    test("describes a collect reason even when the detail mentions the pull request state", () => {
      const reason = dependabotReason("collect", "pull request is not open");

      expect(describeReason(reason)).toBe(
        "dependabotの更新の検査に必要な情報を集められませんでした(pull request is not open)",
      );
    });

    test("keeps a detail that contained a separator as one item", () => {
      const reason = dependabotReason("gate", "a; b");

      expect(describeReason(reason)).toBe(
        "dependabotの更新が、自動でマージする条件を満たしていません(a, b)",
      );
    });

    test("does not describe a reason that only mentions dependabot", () => {
      expect(describeReason("the dependabot gate: failed")).toBe(
        "the dependabot gate: failed",
      );
    });
  });

  describe("nextActionFor for dependabot", () => {
    test.each(CASES)(
      "gives the next action for the $label reason",
      ({ reason, nextAction }) => {
        expect(nextActionFor(reason)).toBe(nextAction);
      },
    );

    test.each(CASES)(
      "never points to retry_work_item for the $label reason",
      ({ reason }) => {
        expect(nextActionFor(reason)).not.toContain("retry_work_item");
      },
    );

    test.each(CASES)(
      "gives the same next action to every flow for the $label reason",
      ({ reason }) => {
        expect(nextActionFor(reason, "pr_fix")).toBe(nextActionFor(reason));
      },
    );

    test("gives the manual action to a gate reason that mentions another rule", () => {
      const reason = dependabotReason("gate", "work_items_active_issue_key");

      expect(nextActionFor(reason)).toBe(MANUAL_ACTION);
    });

    test("never points to retry_work_item for a long detail that was shortened", () => {
      const reason = dependabotReason("collect", "x".repeat(5000));

      expect(nextActionFor(reason)).not.toContain("retry_work_item");
    });
  });

  describe("nextActionFor for a reason of the repository owner check", () => {
    for (const kind of ["prepare", "finish", "poll"] as const) {
      test.each(OWNER_STOP_REASONS)(
        `points to the owners review for the ${kind} reason: %s`,
        (_label, gate) => {
          expect(
            nextActionFor(dependabotReason(kind, gate), "dependabot"),
          ).toBe(OWNER_STOP_ACTION);
        },
      );

      test.each(OWNER_STOP_REASONS)(
        `never points to retry_work_item for the ${kind} reason: %s`,
        (_label, gate) => {
          expect(
            nextActionFor(dependabotReason(kind, gate), "dependabot"),
          ).not.toContain("retry_work_item");
        },
      );
    }

    test.each([
      [
        "id mismatch",
        repoOwnerIdMismatchReason("acme/widgets", 1, 2),
        "リポジトリacme/widgetsのオーナーのIDが、factory_configのownersのID 1と食い違います(現在のID 2)",
      ],
      [
        "not configured",
        repoOwnerNotConfiguredReason("acme/widgets"),
        "リポジトリacme/widgetsのオーナーが、factory_configのownersにありません",
      ],
    ])("describes the %s detail in Japanese", (_label, gate, described) => {
      expect(describeReason(dependabotReason("finish", gate))).toBe(
        `dependabotの更新を、終了の処理(マージや所見の投稿)で止めました(${described})`,
      );
    });

    test("describes a gate detail in Japanese for the prepare reason", () => {
      expect(
        describeReason(
          dependabotReason(
            "prepare",
            repoOwnerNotConfiguredReason("acme/widgets"),
          ),
        ),
      ).toBe(
        "dependabotの更新を、準備の処理(リポジトリの取得と作業ツリーの作成)で止めました(リポジトリacme/widgetsのオーナーが、factory_configのownersにありません)",
      );
    });

    test("keeps the manual action for a prepare reason that is not a gate reason", () => {
      expect(
        nextActionFor(
          dependabotReason("prepare", "the worktree could not be created"),
          "dependabot",
        ),
      ).toBe(MANUAL_ACTION);
    });

    test("describes a gate detail in Japanese for the poll reason", () => {
      expect(
        describeReason(
          dependabotReason(
            "poll",
            repoOwnerNotConfiguredReason("acme/widgets"),
          ),
        ),
      ).toBe(
        "dependabotの更新を、PRを取得する処理で人に回しました(リポジトリacme/widgetsのオーナーが、factory_configのownersにありません)",
      );
    });

    test("points to the owners review when the detail was shortened", () => {
      const reason = dependabotReason(
        "finish",
        repoOwnerIdMismatchReason(`acme/${"w".repeat(300)}`, 1, 2),
      );

      expect(nextActionFor(reason, "dependabot")).toBe(OWNER_STOP_ACTION);
    });

    test("keeps the manual action for a finish reason that is not a gate reason", () => {
      expect(
        nextActionFor(
          dependabotReason("finish", "the findings could not be posted"),
          "dependabot",
        ),
      ).toBe(MANUAL_ACTION);
    });
  });

  describe("nextActionFor with the dependabot flow", () => {
    test.each(CASES)(
      "keeps the specific next action for the $label reason",
      ({ reason, nextAction }) => {
        expect(nextActionFor(reason, "dependabot")).toBe(nextAction);
      },
    );

    test.each([
      "Claude failed",
      "pull request is a draft",
      "pull request is not open",
      "head branch state is unavailable",
      "GitHub rate limit on /repos/a/b: wait 60s",
      "some reason this table does not know",
    ])(
      "gives the manual action to the reason without a prefix: %s",
      (reason) => {
        expect(nextActionFor(reason, "dependabot")).toBe(MANUAL_ACTION);
      },
    );

    test.each([
      "Claude failed",
      "pull request is a draft",
      "head branch state is unavailable",
      "GitHub rate limit on /repos/a/b: wait 60s",
      "some reason this table does not know",
    ])("never points to retry_work_item for: %s", (reason) => {
      expect(nextActionFor(reason, "dependabot")).not.toContain(
        "retry_work_item",
      );
    });

    test("gives the manual action when a reason list has no dependabot item", () => {
      expect(
        nextActionFor("Claude failed; pull request is a draft", "dependabot"),
      ).toBe(MANUAL_ACTION);
    });

    test("uses the dependabot item of a reason list", () => {
      expect(
        nextActionFor(
          `Claude failed; ${DEPENDABOT_MERGE_REFUSED_REASON}`,
          "dependabot",
        ),
      ).toBe("マージできない理由(競合や保護)を確認してください");
    });

    test("leaves the next action for the other flows unchanged", () => {
      expect(nextActionFor("Claude failed")).toContain("retry_work_item");
    });
  });
});

// `pr_workflow_support.ts`の小さな入出力補助のテスト。
describe("pr_workflow_support io", () => {
  describe("readWorktreeFileIfExists", () => {
    test("returns the content when the read succeeds", async () => {
      const content = await readWorktreeFileIfExists("/work/a.txt", () =>
        Promise.resolve("hi"),
      );
      expect(content).toBe("hi");
    });

    test("returns null when the read throws (file missing)", async () => {
      const content = await readWorktreeFileIfExists("/work/missing.txt", () =>
        Promise.reject(new Error("ENOENT")),
      );
      expect(content).toBeNull();
    });
  });
});

// `pr_workflow_support.ts`の、`propose_issue`を扱う純粋関数のテスト。
// `pr_fix_finish.ts`が使う`selectProposeIssueReplies`と`matchReviewThreadForComment`、
// `issue_proposal_apply.ts`が使う`buildIssueProposalReason`、`buildIssueProposalBody`、
// `renderIssueProposalApprovedReply`、`renderIssueProposalRejectedReply`、
// `decidePostProposalStatus`を確かめる。
describe("pr_workflow_support issue proposals", () => {
  function fixReply(overrides: Partial<FixReply> = {}): FixReply {
    return {
      review_comment_id: 1,
      body: "対応します",
      decision: "fixed",
      ...overrides,
    };
  }

  function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
    return {
      id: "PRRT_1",
      isResolved: false,
      path: "a.ts",
      line: 10,
      firstCommentAuthorLogin: "octo-factory",
      firstCommentBody: "[Factory 自動レビュー]\n[MUST] fix this",
      lastCommentAuthorLogin: "octo-factory",
      lastCommentBody: "[Factory 自動レビュー]\n[MUST] fix this",
      firstCommentDatabaseId: 101,
      allCommentIds: [101],
      comments: [],
      lastCommentAuthorId: null,
      lastCommentDatabaseId: null,
      resolvedByLogin: "",
      resolvedById: null,
      ...overrides,
    };
  }

  describe("selectProposeIssueReplies", () => {
    test("keeps only propose_issue replies", () => {
      const fixedReply = fixReply({ review_comment_id: 1, decision: "fixed" });
      const proposeReply = fixReply({
        review_comment_id: 2,
        decision: "propose_issue",
        issue_proposal: { title: "t", body: "b" },
      });
      expect(selectProposeIssueReplies([fixedReply, proposeReply])).toEqual([
        proposeReply,
      ]);
    });

    test("returns an empty array when there are no propose_issue replies", () => {
      expect(selectProposeIssueReplies([fixReply()])).toEqual([]);
    });
  });

  describe("matchReviewThreadForComment", () => {
    test("finds a thread whose first comment id matches", () => {
      const threads = [
        thread({
          id: "PRRT_1",
          firstCommentDatabaseId: 101,
          allCommentIds: [101],
        }),
      ];
      expect(matchReviewThreadForComment(threads, 101)).toBe("PRRT_1");
    });

    test("finds a thread by a later comment's id, not just the first", () => {
      const threads = [
        thread({
          id: "PRRT_1",
          firstCommentDatabaseId: 101,
          allCommentIds: [101, 202],
        }),
      ];
      expect(matchReviewThreadForComment(threads, 202)).toBe("PRRT_1");
    });

    test("returns null when no thread contains the id", () => {
      const threads = [
        thread({
          id: "PRRT_1",
          firstCommentDatabaseId: 101,
          allCommentIds: [101],
        }),
      ];
      expect(matchReviewThreadForComment(threads, 999)).toBeNull();
    });

    test("returns null for an empty thread list (e.g. a plain issue comment)", () => {
      expect(matchReviewThreadForComment([], 101)).toBeNull();
    });
  });

  describe("buildIssueProposalReason", () => {
    test("renders the proposal count into the fixed Japanese reason text", () => {
      expect(buildIssueProposalReason(3)).toBe("Issue化の提案が3件あります");
    });
  });

  describe("buildIssueProposalBody", () => {
    test("removes half-width spaces between ASCII and Japanese in the body", () => {
      const body = buildIssueProposalBody(
        "`src/greet.ts` と `src/shout.ts` の両方",
        "https://example.test/pr/4",
        4,
      );
      expect(body.startsWith("`src/greet.ts`と`src/shout.ts`の両方")).toBe(
        true,
      );
    });

    test("substitutes the {{pr_url}} placeholder with the PR's own URL", () => {
      const body = buildIssueProposalBody(
        "背景\n提案\n{{pr_url}}",
        "https://github.com/octo-owner/atelier-works/pull/1",
        1,
      );
      expect(body).toContain(
        "https://github.com/octo-owner/atelier-works/pull/1",
      );
    });

    test("appends the origin footer without a space between Issue/PR and Japanese", () => {
      const body = buildIssueProposalBody(
        "背景",
        "https://example.com/pr/1",
        42,
      );
      expect(body).toContain(
        "このIssueはPR #42のレビュー指摘から起票されました",
      );
    });
  });

  describe("renderIssueProposalApprovedReply", () => {
    test("starts with the pr_fix role tag", () => {
      expect(renderIssueProposalApprovedReply(42)).toStartWith(
        "[Factory 自動返信]\n",
      );
    });

    test("names the created Issue number", () => {
      expect(renderIssueProposalApprovedReply(42)).toContain(
        "Issue #42を起票しました。",
      );
    });

    test("ends with the Issue number as the disposition", () => {
      const body = renderIssueProposalApprovedReply(42);
      expect(body.split("\n").at(-1)).toBe("対応: Issue #42");
    });
  });

  describe("renderIssueProposalRejectedReply", () => {
    test("starts with the pr_fix role tag", () => {
      expect(renderIssueProposalRejectedReply("scope外のため")).toStartWith(
        "[Factory 自動返信]\n",
      );
    });

    test("includes the human's reason, writing-style normalized", () => {
      const body = renderIssueProposalRejectedReply("scope 外のため");
      expect(body).toContain("理由: scope外のため");
    });

    test("ends with 見送り as the disposition", () => {
      const body = renderIssueProposalRejectedReply("scope外のため");
      expect(body.split("\n").at(-1)).toBe("対応: 見送り");
    });
  });

  describe("decidePostProposalStatus", () => {
    test("keeps the current status while a proposal is still pending", () => {
      expect(decidePostProposalStatus(1, true)).toEqual({ action: "keep" });
    });

    test("swaps to rereview_requested when a commit was pushed this round", () => {
      expect(decidePostProposalStatus(0, true)).toEqual({
        action: "swap",
        toStatus: "rereview_requested",
      });
    });

    test("swaps to reviewed when nothing was pushed this round", () => {
      expect(decidePostProposalStatus(0, false)).toEqual({
        action: "swap",
        toStatus: "reviewed",
      });
    });
  });

  describe("buildIssueProposalTitle", () => {
    test("removes half-width spaces between ASCII and Japanese", () => {
      expect(buildIssueProposalTitle("greet と shout の敬称処理を共通化")).toBe(
        "greetとshoutの敬称処理を共通化",
      );
    });
  });

  describe("buildAuditProposalBody", () => {
    test("appends the audit-report provenance line", () => {
      const body = buildAuditProposalBody("本文", "2026-09-22〜2026-09-28");
      expect(body).toBe(
        "本文\n\nこのIssueは監査レポート(2026-09-22〜2026-09-28)から起票されました",
      );
    });
  });

  describe("decidePostProposalTransition", () => {
    test("keeps the status while proposals are pending", () => {
      expect(decidePostProposalTransition("audit", 1, false)).toEqual({
        action: "keep",
      });
    });

    test("moves an audit from awaiting_approval to audited", () => {
      expect(decidePostProposalTransition("audit", 0, false)).toEqual({
        action: "swap",
        expectedFrom: "awaiting_approval",
        toStatus: "audited",
      });
    });

    test("moves a pr_fix from needs_human to rereview_requested when a commit was pushed", () => {
      expect(decidePostProposalTransition("pr_fix", 0, true)).toEqual({
        action: "swap",
        expectedFrom: "needs_human",
        toStatus: "rereview_requested",
      });
    });

    test("moves a pr_fix from needs_human to reviewed when nothing was pushed", () => {
      const transition = decidePostProposalTransition("pr_fix", 0, false);
      expect(transition.action === "swap" && transition.toStatus).toBe(
        "reviewed",
      );
    });
  });
});

// `pr_workflow_support.ts`の`extractLinkedIssueNumbers`のテスト。
// `poll_prs.ts`は、PR本文にあるGitHubのクローズキーワードでの参照を手がかりに、
// 人が作ったPRを承認済みの要件に結びつける。
describe("pr_workflow_support linked issues", () => {
  const OWNER = "acme";
  const REPO = "widgets";

  describe("extractLinkedIssueNumbers", () => {
    test("extracts a bare Closes #N reference", () => {
      expect(extractLinkedIssueNumbers("Closes #42", OWNER, REPO)).toEqual([
        42,
      ]);
    });

    test("extracts a bare Fixes #N reference", () => {
      expect(extractLinkedIssueNumbers("Fixes #7", OWNER, REPO)).toEqual([7]);
    });

    test("extracts a bare Resolves #N reference", () => {
      expect(extractLinkedIssueNumbers("Resolves #7", OWNER, REPO)).toEqual([
        7,
      ]);
    });

    test("matches every inflection of each keyword", () => {
      const inflections = [
        "close #1",
        "closes #1",
        "closed #1",
        "fix #1",
        "fixes #1",
        "fixed #1",
        "resolve #1",
        "resolves #1",
        "resolved #1",
      ];
      for (const body of inflections) {
        expect(extractLinkedIssueNumbers(body, OWNER, REPO)).toEqual([1]);
      }
    });

    test("matches case-insensitively", () => {
      expect(extractLinkedIssueNumbers("CLOSED #9", OWNER, REPO)).toEqual([9]);
    });

    test("accepts a colon between the keyword and the reference", () => {
      expect(extractLinkedIssueNumbers("Fixes: #3", OWNER, REPO)).toEqual([3]);
    });

    test("dedupes a repeated reference to the same issue", () => {
      const body = "Closes #5\n\nAlso fixes #5.";
      expect(extractLinkedIssueNumbers(body, OWNER, REPO)).toEqual([5]);
    });

    test("preserves first-occurrence order across distinct issues", () => {
      const body = "Fixes #9\nCloses #3";
      expect(extractLinkedIssueNumbers(body, OWNER, REPO)).toEqual([9, 3]);
    });

    test("keeps an explicit owner/repo#N reference to this same repo", () => {
      const body = `Closes ${OWNER}/${REPO}#11`;
      expect(extractLinkedIssueNumbers(body, OWNER, REPO)).toEqual([11]);
    });

    test("matches the owner/repo prefix case-insensitively", () => {
      const body = "Closes ACME/WIDGETS#11";
      expect(extractLinkedIssueNumbers(body, OWNER, REPO)).toEqual([11]);
    });

    test("excludes an explicit owner/repo#N reference to a different repo", () => {
      const body = "Closes other-owner/other-repo#5";
      expect(extractLinkedIssueNumbers(body, OWNER, REPO)).toEqual([]);
    });

    test("returns an empty array when the body has no closing keyword", () => {
      expect(
        extractLinkedIssueNumbers("See #5 for context.", OWNER, REPO),
      ).toEqual([]);
    });

    test("does not match 'close' inside a larger word (e.g. 'disclose')", () => {
      expect(extractLinkedIssueNumbers("discloses #5", OWNER, REPO)).toEqual(
        [],
      );
    });
  });
});

// `pr_workflow_support.ts`の`normalizeJapaneseText`のテスト。
// このプロジェクトの日本語の書式では、英数字と日本語の間に半角スペースを入れない。
// `renderInlineComment`、`renderReviewSummary`、`renderFixReply`は、
// Claudeが構造化出力で返した文章を描画するときにこの関数で整える。
describe("pr_workflow_support normalize japanese", () => {
  describe("normalizeJapaneseText", () => {
    test("removes a space between an ASCII run and a following Japanese character", () => {
      expect(normalizeJapaneseText("3 件コメントしました。")).toBe(
        "3件コメントしました。",
      );
    });

    test("removes a space between a Japanese character and a following ASCII run", () => {
      expect(normalizeJapaneseText("修正を確認しました。LGTM です。")).toBe(
        "修正を確認しました。LGTMです。",
      );
    });

    test("removes spaces on both sides of an ASCII run surrounded by Japanese", () => {
      expect(normalizeJapaneseText("これは Approve 判断です。")).toBe(
        "これはApprove判断です。",
      );
    });

    test("treats a closing ) as an ASCII boundary character", () => {
      expect(normalizeJapaneseText("対応済み(fixed) です。")).toBe(
        "対応済み(fixed)です。",
      );
    });

    test("leaves an inline code span's internal spacing untouched", () => {
      const input = "`const x = 1` です。";
      expect(normalizeJapaneseText(input)).toBe("`const x = 1`です。");
    });

    test("leaves the space inside an inline code span untouched", () => {
      const input = "`foo bar` の説明。";
      const result = normalizeJapaneseText(input);
      expect(result).toContain("`foo bar`");
    });

    test("leaves a fenced code block's internal spacing untouched", () => {
      const input = "説明:\n```\nconst x = 1;\nconst y = 2;\n```\n以上です。";
      expect(normalizeJapaneseText(input)).toBe(input);
    });

    test("normalizes spacing on each line while preserving every newline", () => {
      const input = "1行目です。\n3 件コメントしました。\n3行目です。";
      expect(normalizeJapaneseText(input)).toBe(
        "1行目です。\n3件コメントしました。\n3行目です。",
      );
    });

    test("does not remove a space immediately before a newline, even if Japanese follows on the next line", () => {
      const input = "見出し \n日本語の本文。";
      expect(normalizeJapaneseText(input)).toBe(input);
    });

    test("leaves English-only text untouched", () => {
      const input = "This is a plain English sentence with 42 items.";
      expect(normalizeJapaneseText(input)).toBe(input);
    });

    test("leaves a space between two ASCII runs untouched", () => {
      expect(normalizeJapaneseText("hello world")).toBe("hello world");
    });

    test("leaves a space between two Japanese characters untouched (there is none to begin with, but a full-width one is unaffected)", () => {
      expect(normalizeJapaneseText("日本語  日本語")).toBe("日本語  日本語");
    });
  });
});

// `pr_workflow_support.ts`の`withReviewMarkers`と`findPostedReviewId`のテスト。
// `pr_review_post.ts`は、投稿の後に記録する前にステップが落ちても、
// 再実行で同じレビューをもう一度投稿しないよう、この2つで投稿済みのレビューを見つける。
describe("pr_workflow_support posted review", () => {
  const VIEWER = "factory-bot";
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";
  const SUMMARY = "[Factory 自動レビュー] @alice\n指摘はありません。LGTMです。";

  function review(
    overrides: Partial<PostedReviewCandidate> = {},
  ): PostedReviewCandidate {
    return {
      id: 42,
      authorLogin: VIEWER,
      body: withReviewMarkers(SUMMARY, 7, SHA),
      ...overrides,
    };
  }

  describe("withReviewMarkers", () => {
    test("keeps the pr_review marker of the work item as the last line", () => {
      const body = withReviewMarkers(SUMMARY, 7, SHA);
      expect(hasMarker(body, "pr_review", 7)).toBe(true);
    });

    test("keeps the summary as the beginning of the body", () => {
      const body = withReviewMarkers(SUMMARY, 7, SHA);
      expect(body).toStartWith(`${SUMMARY}\n`);
    });

    // pr_fixの指摘の収集(`listPrReviews`)が除くのはpr_fixの返信だけで、
    // pr_reviewのレビューは対応すべきフィードバックとして残す。
    test("is not mistaken for a pr_fix reply", () => {
      const body = withReviewMarkers(SUMMARY, 7, SHA);
      expect(isFactoryPost(VIEWER, VIEWER, body, "pr_fix")).toBe(false);
    });

    // shaがすべて数字でも、Factoryの目印として読まれないこと。
    test("does not add a line that reads as a factory marker", () => {
      const body = withReviewMarkers("summary", 7, "1234567");
      const markerLines = body
        .split("\n")
        .filter((line) => line.startsWith("<!-- factory:"));
      expect(markerLines).toEqual(["<!-- factory:pr_review:7 -->"]);
    });
  });

  describe("findPostedReviewId", () => {
    test("returns the id of the viewer's review for the same work item and sha", () => {
      expect(findPostedReviewId([review()], VIEWER, 7, SHA)).toBe(42);
    });

    test("matches the viewer login case-insensitively", () => {
      const reviews = [review({ authorLogin: "Factory-Bot" })];
      expect(findPostedReviewId(reviews, VIEWER, 7, SHA)).toBe(42);
    });

    test("returns null when the review is for another sha", () => {
      const reviews = [
        review({ body: withReviewMarkers(SUMMARY, 7, OTHER_SHA) }),
      ];
      expect(findPostedReviewId(reviews, VIEWER, 7, SHA)).toBeNull();
    });

    test("returns null when the review is for another work item", () => {
      const reviews = [review({ body: withReviewMarkers(SUMMARY, 8, SHA) })];
      expect(findPostedReviewId(reviews, VIEWER, 7, SHA)).toBeNull();
    });

    // 目印は誰でも本文に貼り付けられるので、投稿者が自分でなければ投稿済みとみなさない。
    test("returns null when the review was written by someone else", () => {
      const reviews = [review({ authorLogin: "alice" })];
      expect(findPostedReviewId(reviews, VIEWER, 7, SHA)).toBeNull();
    });

    // shaの目印を持たないレビューは、どのshaに対するものか分からない。
    test("returns null for a review that carries no sha marker", () => {
      const reviews = [review({ body: withMarker("pr_review", 7, SUMMARY) })];
      expect(findPostedReviewId(reviews, VIEWER, 7, SHA)).toBeNull();
    });

    test("returns null when there are no reviews", () => {
      expect(findPostedReviewId([], VIEWER, 7, SHA)).toBeNull();
    });

    // 本文の途中に貼り付けられたshaの目印は、投稿済みの証拠にならない。
    test("returns null when the sha marker is in the middle of the body", () => {
      const forged = withMarker(
        "pr_review",
        7,
        `${SUMMARY}\n\n<!-- factory-review-sha:${SHA} -->\n\nmore text`,
      );
      const reviews = [review({ body: forged })];
      expect(findPostedReviewId(reviews, VIEWER, 7, SHA)).toBeNull();
    });

    test("matches when the body ends with trailing whitespace", () => {
      const reviews = [
        review({ body: `${withReviewMarkers(SUMMARY, 7, SHA)}\n\n  ` }),
      ];
      expect(findPostedReviewId(reviews, VIEWER, 7, SHA)).toBe(42);
    });

    test("matches a body whose line endings were converted to CRLF", () => {
      const crlf = withReviewMarkers(SUMMARY, 7, SHA).replace(/\n/g, "\r\n");
      const reviews = [review({ body: crlf })];
      expect(findPostedReviewId(reviews, VIEWER, 7, SHA)).toBe(42);
    });
  });
});

describe("pr_workflow_support prose", () => {
  describe("reviewOutputProseIssues", () => {
    test("reports a plain ending in a finding message", () => {
      const issues = reviewOutputProseIssues({
        verdict: "comment",
        summary: "要約である。",
        findings: [
          {
            path: "src/a.ts",
            line: 1,
            end_line: null,
            severity: "minor",
            kind: "imo",
            message: "この分岐は不要である。",
            suggestion: null,
            suggested_code: null,
          },
        ],
        thread_responses: [],
      });

      expect(issues).toEqual([
        "findings[0].message: 1行目: 敬体(です・ます)で書く文章に、別の文体の文末があります(である。)",
      ]);
    });

    test("reports a plain ending in a thread response", () => {
      const issues = reviewOutputProseIssues({
        verdict: "comment",
        summary: "要約です。",
        findings: [],
        thread_responses: [
          { thread_id: 1, decision: "skip_rejected", body: "不要である。" },
        ],
      });

      expect(issues).toEqual([
        "thread_responses[0].body: 1行目: 敬体(です・ます)で書く文章に、別の文体の文末があります(である。)",
      ]);
    });

    test("does not check the summary, which is never posted", () => {
      const issues = reviewOutputProseIssues({
        verdict: "comment",
        summary: "要約である。",
        findings: [],
        thread_responses: [],
      });

      expect(issues).toEqual([]);
    });
  });

  describe("fixOutputProseIssues", () => {
    test("reports bold in a reply body", () => {
      const issues = fixOutputProseIssues(
        [
          {
            review_comment_id: 1,
            body: "**修正しました**。",
            decision: "fixed",
          },
        ],
        "fix: 型の検査を足す",
        null,
      );

      expect(issues).toEqual([
        "replies[0].body: 1行目: 太字(**)があります。強調に太字を使わないでください",
      ]);
    });

    test("reports a polite ending in the commit subject", () => {
      const issues = fixOutputProseIssues(
        [],
        "fix: 型の検査を足しました",
        null,
      );

      expect(issues).toHaveLength(1);
    });

    test("reports a polite ending in the commit body of a CI round, which has no replies", () => {
      const issues = fixOutputProseIssues(
        [],
        "fix: ログの解析を直す",
        "- 失敗の原因を直しました",
      );

      expect(issues).toEqual([
        "commit_body: 1行目: 常体で書く文章に、別の文体の文末があります(ました)",
      ]);
    });

    test("accepts a plain commit body of a CI round", () => {
      const issues = fixOutputProseIssues(
        [],
        "fix: ログの解析を直す",
        "- 失敗の原因を直す",
      );

      expect(issues).toEqual([]);
    });
  });
});

// 理由の規則の表の全体に対する検査。個々の理由ではなく、表の構造の約束を確かめる。
describe("pr_workflow_support reason rules", () => {
  /** 規則の`nextAction`や`ciNextAction`が、一致の中身で分岐しても全部の枝を通すための一致の結果。 */
  function matchesOf(text: string): RegExpMatchArray[] {
    const match = text.match(/([\s\S]*)/);
    return match === null ? [] : [match];
  }

  const MATCHES = [
    ...matchesOf("x"),
    ...matchesOf("GitHub rate limit on endpoint: wait"),
    ...matchesOf("check sandbox: x"),
  ];

  const BARE_RETRY_ACTION =
    "Windmillで`f/factory/retry_work_item`を作業項目のIDで実行してください";
  const RETRY_ENDING = "retry_work_item`を作業項目のIDで実行してください";

  /**
   * 手順の後に再実行を続けるが、CI回用の次の操作を持たなくてよい規則。
   * 理由はどれも、CI回が作らない(実装フローか、要件定義のフローが出す)か、
   * 人が基盤を直す手順ではなく、別の実行の完了を待つ案内である。
   * CI回では、CIの再評価を待つ一律の案内に置き換わる。
   */
  const WITHOUT_CI_ACTION = [
    "^could not request re-review",
    "^claude run failed",
    "^branch head moved to",
    "^implement finished without",
    "^worktree changed before the secret scan in round",
    "^pull request has an active fix run",
    "^parent issue is being re-implemented",
    "^implementation of the branch's work item is running",
    "^implement flow deadline passed",
    "^implement time settings do not fit",
    "^design ",
    "^design ",
    "^approval decision could not be applied",
  ];

  describe("REASON_RULES in a CI round", () => {
    test("never points to a retry or a relabel", () => {
      const pointing = REASON_RULES.flatMap((rule) =>
        MATCHES.map((match) => ({
          pattern: rule.pattern.source,
          action: ciRoundActionOfRule(rule, match),
        })),
      ).filter(
        ({ action }) =>
          action.includes("retry_work_item") ||
          action.includes("factory:fix") ||
          action.includes("付け直"),
      );
      expect(pointing).toEqual([]);
    });

    test("keeps the CI action of every rule that follows a procedure with a retry", () => {
      const missing = REASON_RULES.filter(
        (rule) =>
          rule.ciNextAction === undefined &&
          MATCHES.some((match) => {
            const action = rule.nextAction(match, "pr_fix");
            return (
              action.endsWith(RETRY_ENDING) && action !== BARE_RETRY_ACTION
            );
          }) &&
          !WITHOUT_CI_ACTION.some((prefix) =>
            rule.pattern.source.startsWith(prefix),
          ),
      ).map((rule) => rule.pattern.source);
      expect(missing).toEqual([]);
    });
  });
});
