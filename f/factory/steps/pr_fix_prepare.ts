// f/factory/pr_fixの準備ステップ。
// 修正を始めてよいかを検査し、通ればPRのheadブランチのworktreeを用意する。

import * as wmill from "windmill-client@1.817.0";
import {
  CheckEnvironmentError,
  checkImageGate,
  checkImageProblemsFromEnv,
} from "../lib/check_sandbox.ts";
import {
  ciRoundApplyTimeoutMisfit,
  discardIgnoredFiles,
  evaluateCiRoundPrepareGuard,
} from "../lib/ci_fix_round.ts";
import { isRepoAllowed, loadConfig } from "../lib/config.ts";
import {
  addNoticeUnlessUnresolved,
  getPrCiCheckById,
  getWorkItem,
} from "../lib/db.ts";
import { openFactoryClone } from "../lib/factory_clone.ts";
import { type GhClient, getPr } from "../lib/github.ts";
import { recordCheckEnvironmentNotice } from "../lib/host_action.ts";
import { parseImplementBranchWorkItemId } from "../lib/implement_support.ts";
import { logger } from "../lib/log.ts";
import {
  defaultLockReleaseDeps,
  ensureWorktreeLockFree,
  WorktreeBusyError,
  worktreeLockFor,
} from "../lib/process_lock.ts";
import {
  repoOwnerGateDeps,
  verifyRepoOwnerId,
} from "../lib/repo_owner_gate.ts";
import { assertGitHubName } from "../lib/types.ts";
import {
  createGtrWorktree,
  ensureRepo,
  type GtrWorktree,
  readAndVerifyWorktreeGitPointer,
  runCommand,
} from "../lib/workspace.ts";
import {
  earlyExitBase,
  evaluateBranchImplementingGuard,
  evaluateFixRoundGuard,
  evaluateHumanOnlyBranchGuard,
  evaluateParentImplementingGuard,
  evaluatePrFixSafetyGuards,
  evaluateRepoAllowedGuard,
  fetchPrFixHeadBranchState,
  PR_COMMAND_STOP_OVERHEAD_SEC,
  PR_FIX_APPLY_STEP_TIMEOUT_SEC,
  PR_STEP_OVERRUN_BASE_SEC,
  type PrFixGateOutcome,
  type PrFixHeadBranchState,
  prFixTimeoutMisfit,
  shouldReadPrFixHeadState,
} from "./pr_workflow_support.ts";

export type PrFixPrepareResult = {
  readonly outcome: PrFixGateOutcome;
  readonly reason: string | null;
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
  readonly head_sha: string;
  readonly worktree_dir: string;
  readonly repo_dir: string;
  readonly factory_clone_dir: string;
  /**
   * worktreeを用意した直後の`<worktree_dir>/.git`の中身(`readWorktreeGitPointer`)。
   * 検証ステップは、Claudeの実行の後にworktreeでgitを実行する前に、必ずこれと比べる。
   * worktreeを用意しなかったときはnull。
   */
  readonly worktree_git_pointer: string | null;
  /** PRのheadブランチ。検証ステップがworktreeのHEADがこのブランチにあるかを確かめる。worktreeを用意しなかったときは空文字列。 */
  readonly branch: string;
  readonly parent_work_item_id: number | null;
  readonly attempt: number;
  readonly fix_round: number;
  /** CIの失敗を直す回なら、直す`pr_ci_checks`の行のID。指摘を直す回はnull。 */
  readonly ci_check_id: number | null;
};

/**
 * 作業項目を読み、対象リポジトリの許可、リポジトリのオーナーの数値IDの照合(`verifyRepoOwnerId`)、
 * 修正ラウンドの上限、
 * 時間設定が修正・検証ステップのtimeoutに収まること、
 * 親Issueの再実装中でないこと、PRの安全条件
 * (open、headとbaseが同じリポジトリ、draftでない、headブランチが保護ブランチでもデフォルトブランチでもない)
 * を順に検査する。
 * 検査に通らなければ`outcome`に理由を入れて返し、worktreeは作らない。
 * すべて通ったときだけ、Factoryのself cloneと対象リポジトリのcloneを用意し、
 * PRのheadブランチに`git gtr`のworktreeを作る。
 * detachedではなく実ブランチのworktreeにするのは、
 * `commitAndPush`がそのブランチへpushし直すため。
 * 作ったworktreeは`.git`ファイルを1回だけ読んで検証し(`readAndVerifyWorktreeGitPointer`)、その中身を`worktree_git_pointer`として返す。
 * 検証に通らなければ例外を投げる。
 * PRのブランチ名から引いた実装の作業項目が`implementing`なら`guard_blocked`を返す。
 * worktreeを前の実行のプロセスがまだ使っていれば、何も止めずに保持者を理由に載せて`guard_blocked`を返す。
 * `allowed_check_commands`があり、workerが検査を実行できないときと、枠の記録が指すworktreeを同じ理由で取り戻せないときは、
 * 要対応の通知を残して`guard_blocked`を返す。通知は、イメージが古ければ`host_action_required`、稼働中のworkerの問題なら`check_runtime_unsafe`である。
 * 作業項目が無い、またはPR番号が無いときは例外を投げる。
 * CIの失敗を直す回(`ci_check_id`が非NULL)は、次を変える。
 * - 修正ラウンドの上限(`max_fix_rounds`)を確かめない。その回は`fix_round`を前の値のまま写すためである。
 * - 失敗の行が、いまのPRのheadについて、この作業項目で`fixing`であることを確かめる。違えば`guard_blocked`を返す。
 *   `skip`にすると、完了ステップが何もせず、作業項目が`fixing`のまま残るためである。
 * - 修正ステップの時間が、gitleaksの追加の実行を含めて収まることを確かめる。
 * - worktreeを用意した後、無視されたファイルを消す。Claudeが書いた無視されたファイルを、後の検査で見分けるためである。
 */
export async function main(work_item_id: number): Promise<PrFixPrepareResult> {
  const workItem = await getWorkItem(work_item_id);
  if (workItem === null) {
    throw new Error(`pr_fix_prepare: no work item with id ${work_item_id}`);
  }

  if (workItem.kind !== "pr_fix" || workItem.status !== "fixing") {
    return {
      outcome: "skip",
      reason: `work item kind/status is "${workItem.kind}"/"${workItem.status}", not "pr_fix"/"fixing"`,
      ...earlyExitBase(workItem),
    };
  }
  if (workItem.pr_number === null) {
    throw new Error(
      `pr_fix_prepare: work item ${work_item_id} has no pr_number`,
    );
  }
  assertGitHubName(workItem.owner);
  assertGitHubName(workItem.repo);

  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );

  // 多層防御のための再検査。
  // `poll_prs.ts`は作業項目を作る前に許可リストで絞っているが、
  // その後に`factory_config`を変えると、許可外になったリポジトリを
  // 指す作業項目が残りうる。
  const repoGuard = evaluateRepoAllowedGuard(
    isRepoAllowed(config, workItem.owner, workItem.repo),
  );
  if (!repoGuard.ok) {
    return {
      outcome: "guard_blocked",
      reason: repoGuard.reason,
      ...earlyExitBase(workItem),
    };
  }

  // リポジトリのcloneより前に、オーナーの数値IDを`owners`と照合する。
  // 名前が別の人に渡っていれば、他人のコードをcloneも検査もしない。
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };
  const ownerGuard = await verifyRepoOwnerId(
    config,
    workItem.owner,
    workItem.repo,
    repoOwnerGateDeps(client, addNoticeUnlessUnresolved),
  );
  if (!ownerGuard.ok) {
    return {
      outcome: "guard_blocked",
      reason: ownerGuard.reason,
      ...earlyExitBase(workItem),
    };
  }

  const ciRound = workItem.ci_check_id !== null;
  const roundGuard = evaluateFixRoundGuard(
    workItem.fix_round,
    config.max_fix_rounds,
    ciRound,
  );
  if (!roundGuard.ok) {
    return {
      outcome: "round_exhausted",
      reason: roundGuard.reason,
      ...earlyExitBase(workItem),
    };
  }

  // 修正・検証ステップの最悪の所要時間がflow.yamlのtimeoutに収まらない設定では、
  // Windmillがアプリ側のtimeoutより先にステップを打ち切るため、worktreeに触れる前に止める。
  const timeoutMisfit =
    prFixTimeoutMisfit(config) ??
    (ciRound
      ? ciRoundApplyTimeoutMisfit(
          config.claude_timeout_sec,
          PR_FIX_APPLY_STEP_TIMEOUT_SEC,
          {
            commandStopSec: PR_COMMAND_STOP_OVERHEAD_SEC,
            baseSec: PR_STEP_OVERRUN_BASE_SEC,
          },
        )
      : null);
  if (timeoutMisfit !== null) {
    return {
      outcome: "guard_blocked",
      reason: timeoutMisfit,
      ...earlyExitBase(workItem),
    };
  }

  // 前提を満たさないまま進むと、Claudeの修正を1回使ってから検証のステップで止まるので、Claudeより前に確かめる。
  // 関門と同じ`guard_blocked`で止め、修正のラウンドを記録しない。
  const reportStaleImage = (error: CheckEnvironmentError): Promise<void> =>
    recordCheckEnvironmentNotice(
      {
        readDeployedSha: () => wmill.getVariable("f/factory/deployed_sha"),
        addNotice: addNoticeUnlessUnresolved,
        log: logger("pr_fix_prepare"),
      },
      error,
    );
  const staleImage = await checkImageGate(
    config.allowed_check_commands.length > 0,
    { problems: () => checkImageProblemsFromEnv(), report: reportStaleImage },
  );
  if (staleImage !== null) {
    return {
      outcome: "guard_blocked",
      reason: staleImage,
      ...earlyExitBase(workItem),
    };
  }

  // 親Issueを再実装するimplementフローも同じブランチのworktreeを使うため、
  // 両者を同時に動かさない。
  const parent =
    workItem.parent_work_item_id === null
      ? null
      : await getWorkItem(workItem.parent_work_item_id);
  const parentGuard = evaluateParentImplementingGuard(parent?.status ?? null);
  if (!parentGuard.ok) {
    return {
      outcome: "guard_blocked",
      reason: parentGuard.reason,
      ...earlyExitBase(workItem),
    };
  }

  const pr = await getPr(
    client,
    workItem.owner,
    workItem.repo,
    workItem.pr_number,
  );
  if (workItem.ci_check_id !== null) {
    const ciGuard = evaluateCiRoundPrepareGuard({
      workItemId: work_item_id,
      prHeadSha: pr.headSha,
      row: await getPrCiCheckById(workItem.ci_check_id),
    });
    if (!ciGuard.ok) {
      return {
        outcome: "guard_blocked",
        reason: ciGuard.reason,
        ...earlyExitBase(workItem),
      };
    }
  }
  // 親の行が無くても(parent_work_item_idがnull)、ブランチ名から実装の作業項目を引き、実装フローの実行中ならworktreeに触れない。
  const branchItemId = parseImplementBranchWorkItemId(pr.headRef);
  const branchItem =
    branchItemId === null ? null : await getWorkItem(branchItemId);
  const branchGuard = evaluateBranchImplementingGuard(
    branchItem !== null &&
      branchItem.kind === "issue" &&
      branchItem.owner === workItem.owner &&
      branchItem.repo === workItem.repo
      ? branchItem.status
      : null,
  );
  if (!branchGuard.ok) {
    return {
      outcome: "guard_blocked",
      reason: branchGuard.reason,
      ...earlyExitBase(workItem),
    };
  }
  const humanOnly = evaluateHumanOnlyBranchGuard(pr.headRef);
  if (!humanOnly.ok) {
    return {
      outcome: "guard_blocked",
      reason: humanOnly.reason,
      ...earlyExitBase(workItem),
    };
  }
  // 読まないPRは、先に判定する関門(open、同一リポジトリ、draft)が理由を残して止める。
  const headBranch: PrFixHeadBranchState | null = shouldReadPrFixHeadState(
    pr.state === "open",
    pr.draft,
    pr.headRepoFullName,
    pr.baseRepoFullName,
  )
    ? await fetchPrFixHeadBranchState(
        client,
        workItem.owner,
        workItem.repo,
        pr.headRef,
      )
    : null;

  const safety = evaluatePrFixSafetyGuards({
    open: pr.state === "open",
    headRepoFullName: pr.headRepoFullName,
    baseRepoFullName: pr.baseRepoFullName,
    draft: pr.draft,
    autoMergeEnabled: pr.autoMergeEnabled,
    headBranch,
  });
  if (!safety.ok) {
    return {
      outcome: "guard_blocked",
      reason: safety.reason,
      ...earlyExitBase(workItem),
    };
  }

  const factoryClone = await openFactoryClone(config, {
    run: runCommand,
    ghToken,
  });
  const { dir: repoDir } = await ensureRepo({
    run: runCommand,
    owner: workItem.owner,
    repo: workItem.repo,
    ghToken,
  });

  let worktree: GtrWorktree;
  try {
    worktree = await createGtrWorktree({
      run: runCommand,
      repoDir,
      branch: pr.headRef,
      ghToken,
      // pr_fixは実装フローのリースを持たないので、保持者が終わった実行の生き残りと言えない。何も止めずに理由へ載せる。
      assertProcessesIdle: async (dir) =>
        (
          await ensureWorktreeLockFree({
            run: runCommand,
            lock: worktreeLockFor(dir),
            policy: null,
            deps: defaultLockReleaseDeps(),
          })
        ).length > 0,
    });
  } catch (err) {
    // pr_fixのprepareにはneeds_humanの出口が無い。blockedはretry_work_itemで再実行できる。
    if (err instanceof WorktreeBusyError) {
      return {
        outcome: "guard_blocked",
        reason: err.message,
        ...earlyExitBase(workItem),
      };
    }
    // 枠の記録がworktreeを指すのに、workerが検査の前提を満たさず取り戻せない。worktreeには触れていない。
    if (err instanceof CheckEnvironmentError) {
      await reportStaleImage(err);
      return {
        outcome: "guard_blocked",
        reason: err.message,
        ...earlyExitBase(workItem),
      };
    }
    throw err;
  }
  // 以降のポインタ照合の基準値になる。
  // 前回の実行が書き換えたまま残したポインタを、信頼する値にしてはならない。
  // 検証した1回の読み取りをそのまま記録する。
  const worktreeGitPointer = await readAndVerifyWorktreeGitPointer({
    run: runCommand,
    repoDir,
    dir: worktree.path,
  });
  if (ciRound) {
    // 再利用したworktreeには、前の実行の生成物が無視されたまま残る。消さないと、
    // 修正の後の検査で、Claudeが書いた無視されたファイルと見分けられない。
    await discardIgnoredFiles(runCommand, worktree.path);
  }

  return {
    outcome: "proceed",
    reason: null,
    owner: workItem.owner,
    repo: workItem.repo,
    pr_number: workItem.pr_number,
    head_sha: pr.headSha,
    worktree_dir: worktree.path,
    repo_dir: repoDir,
    factory_clone_dir: factoryClone.dir,
    worktree_git_pointer: worktreeGitPointer,
    branch: pr.headRef,
    parent_work_item_id: workItem.parent_work_item_id,
    attempt: workItem.attempt,
    fix_round: workItem.fix_round,
    ci_check_id: workItem.ci_check_id,
  };
}
