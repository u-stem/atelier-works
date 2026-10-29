// f/factory/pr_fixの準備ステップ。
// 修正を始めてよいかを検査し、通ればPRのheadブランチのworktreeを用意する。

import * as wmill from "windmill-client@1.817.0";
import { readBranchItemStatus } from "../lib/branch_hold.ts";
import {
  CheckEnvironmentError,
  checkImageGate,
  checkImageProblemsFromEnv,
} from "../lib/check_sandbox.ts";
import { evaluateCiRoundPrepareGuard } from "../lib/ci_fix_round.ts";
import { isRepoAllowed, loadConfig } from "../lib/config.ts";
import {
  CONFLICT_ROUND_DETAILS,
  conflictRoundReason,
  evaluateConflictRoundPrepareGuard,
  isConflictRound,
  planConflictPrepare,
  roundStopReason,
} from "../lib/conflict_fix_round.ts";
import {
  addNoticeUnlessUnresolved,
  getPrCiCheckById,
  getPrConflictCheckById,
  getWorkItem,
} from "../lib/db.ts";
import { openFactoryClone } from "../lib/factory_clone.ts";
import {
  type GhClient,
  getDefaultBranch,
  getPr,
  getViewer,
  gitIdentityForViewer,
} from "../lib/github.ts";
import { recordCheckEnvironmentNotice } from "../lib/host_action.ts";
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
  CommitBlockedError,
  type ConflictBlobs,
  createGtrWorktree,
  ensureRepo,
  type GtrWorktree,
  listBothSidesChangedPaths,
  mergeBaseIntoWorktree,
  readAndVerifyWorktreeGitPointer,
  removeIgnoredFiles,
  runCommand,
} from "../lib/workspace.ts";
import {
  ciRoundTimeoutMisfit,
  conflictRoundTimeoutMisfit,
  earlyExitBase,
  evaluateBranchImplementingGuard,
  evaluateFixRoundGuard,
  evaluateHumanOnlyBranchGuard,
  evaluateParentImplementingGuard,
  evaluatePrFixSafetyGuards,
  evaluateRepoAllowedGuard,
  fetchPrFixHeadBranchState,
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
  /** 競合を直す回なら、直す`pr_conflict_checks`の行のID。それ以外はnull。 */
  readonly conflict_check_id: number | null;
  /** 競合回の基準コミット(ローカルだけにある、baseをmergeしたコミット)のsha。検証と完了のステップが、HEADの照合とpushの親の照合に使う。 */
  readonly baseline_sha: string | null;
  /** 競合回で、mergeしたbaseの先頭のsha。mergeコミットの第2親になる。 */
  readonly base_sha: string | null;
  /** 基準コミットのツリーのsha。 */
  readonly auto_tree_sha: string | null;
  /** 競合ファイルのパス。空なら、競合の無いmergeである。 */
  readonly conflicted_paths: string[] | null;
  /** 競合ファイルごとの、3つの版のblobのsha。基準コミットの後は`ls-files -u`から取れないので、ここで運ぶ。 */
  readonly conflict_blobs: ConflictBlobs[] | null;
};

/** 競合回の準備が記録する値。競合回でなければ、すべてnullである。 */
type ConflictPrepared = Pick<
  PrFixPrepareResult,
  | "baseline_sha"
  | "base_sha"
  | "auto_tree_sha"
  | "conflicted_paths"
  | "conflict_blobs"
>;

const NO_CONFLICT: ConflictPrepared = {
  baseline_sha: null,
  base_sha: null,
  auto_tree_sha: null,
  conflicted_paths: null,
  conflict_blobs: null,
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
 * PRのブランチ名から引いた作業項目が、設計の段階から実装の間(`designing`、`awaiting_design_approval`、`approved`、`implementing`)なら`guard_blocked`を返す。
 * 競合回では、止めた理由の注記を、設計の段階か実装かで分ける。
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
 *
 * マージの競合を直す回(`conflict_check_id`が非NULL)は、次を変える。
 * - 修正ラウンドの上限(`max_fix_rounds`)を確かめない。その回は`fix_round`を前の値のまま写すためである。
 * - 修正ステップの時間が、gitleaksの追加の実行を含めて収まることを確かめる。
 * - 競合の行が、いまのPRのheadについて、この作業項目で競合のままであることと、PRのbaseが既定のブランチであることを確かめる。
 *   行の食い違いは`guard_blocked`、baseが既定のブランチでないときは`conflict_blocked`を返す。
 * - worktreeを用意した後、baseをmergeして基準コミットを作る(`mergeBaseIntoWorktree`)。結果は次のとおり。
 *   mergeできて検査に通れば、基準コミットなどを返して`proceed`にする。baseがすでにPRにあれば`conflict_up_to_date`、
 *   直せない競合と、保護パスやworkflowの変更は`conflict_blocked`、HEADが動いていれば`guard_blocked`を返す。
 *   後ろの4つは、Claudeを起動しない。
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
  const conflictRound = isConflictRound(workItem);
  const roundGuard = evaluateFixRoundGuard(
    workItem.fix_round,
    config.max_fix_rounds,
    ciRound || conflictRound,
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
  const timeoutMisfit = ciRound
    ? ciRoundTimeoutMisfit(config)
    : conflictRound
      ? conflictRoundTimeoutMisfit(config)
      : prFixTimeoutMisfit(config);
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
      reason: roundStopReason(
        conflictRound,
        CONFLICT_ROUND_DETAILS.implementRunning,
        parentGuard.reason,
      ),
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
  if (workItem.conflict_check_id !== null) {
    const conflictGuard = evaluateConflictRoundPrepareGuard({
      workItemId: work_item_id,
      workItemEpisode: workItem.conflict_episode,
      prHeadSha: pr.headSha,
      baseRef: pr.baseRef,
      defaultBranch: await getDefaultBranch(
        client,
        workItem.owner,
        workItem.repo,
      ),
      row: await getPrConflictCheckById(workItem.conflict_check_id),
    });
    if (!conflictGuard.ok) {
      return {
        outcome: conflictGuard.outcome,
        reason: conflictGuard.reason,
        ...earlyExitBase(workItem),
      };
    }
  }
  // 親の行が無くても(parent_work_item_idがnull)、ブランチ名から作業項目を引き、設計の段階か実装の間ならworktreeに触れない。
  // 競合回の注記は、ガードの種別で選ぶ。
  const branchGuard = evaluateBranchImplementingGuard(
    await readBranchItemStatus(
      { headRef: pr.headRef, owner: workItem.owner, repo: workItem.repo },
      getWorkItem,
    ),
  );
  if (!branchGuard.ok) {
    const branchDetail =
      branchGuard.kind === "design_stage"
        ? CONFLICT_ROUND_DETAILS.designStage
        : CONFLICT_ROUND_DETAILS.implementRunning;
    return {
      outcome: "guard_blocked",
      reason: roundStopReason(conflictRound, branchDetail, branchGuard.reason),
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
      // 競合回の注記は固定文なので、保持者の情報はログに残す。
      if (conflictRound) {
        logger("pr_fix_prepare").warn("the worktree is in use", {
          work_item_id,
          holder: err.message,
        });
      }
      return {
        outcome: "guard_blocked",
        reason: roundStopReason(
          conflictRound,
          CONFLICT_ROUND_DETAILS.worktreeBusy,
          err.message,
        ),
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
    await removeIgnoredFiles({ run: runCommand, worktreeDir: worktree.path });
  }

  let conflict: ConflictPrepared = NO_CONFLICT;
  if (conflictRound) {
    // baseをmergeして基準コミットを作る。無視されたファイルの片付けは`mergeBaseIntoWorktree`が行う。
    let merge: Awaited<ReturnType<typeof mergeBaseIntoWorktree>>;
    try {
      merge = await mergeBaseIntoWorktree({
        run: runCommand,
        repoDir,
        dir: worktree.path,
        branch: pr.headRef,
        worktreeGitPointer,
        ghToken,
        prHeadSha: pr.headSha,
        baseBranch: pr.baseRef,
        author: gitIdentityForViewer(await getViewer(client)),
      });
    } catch (err) {
      // worktreeの状態が前提と違う(ローカルの変更、HEADの食い違いなど)。mergeには進めない。
      if (err instanceof CommitBlockedError) {
        return {
          outcome: "guard_blocked",
          reason: err.message,
          ...earlyExitBase(workItem),
        };
      }
      throw err;
    }
    const plan = await planConflictPrepare(merge, (autoTreeSha, baseSha) =>
      listBothSidesChangedPaths({
        run: runCommand,
        worktreeDir: worktree.path,
        prHeadSha: pr.headSha,
        baseSha,
        treeSha: autoTreeSha,
      }),
    );
    if (plan.kind === "up_to_date") {
      return {
        outcome: "conflict_up_to_date",
        reason: null,
        ...earlyExitBase(workItem),
      };
    }
    if (plan.kind === "blocked") {
      return {
        outcome: "conflict_blocked",
        reason: plan.reason,
        ...earlyExitBase(workItem),
      };
    }
    if (plan.kind === "head_changed") {
      return {
        outcome: "guard_blocked",
        reason: conflictRoundReason(CONFLICT_ROUND_DETAILS.headMoved),
        ...earlyExitBase(workItem),
      };
    }
    conflict = {
      baseline_sha: plan.autoSha,
      base_sha: plan.baseSha,
      auto_tree_sha: plan.autoTreeSha,
      conflicted_paths: plan.conflictedPaths,
      conflict_blobs: plan.conflictBlobs,
    };
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
    conflict_check_id: workItem.conflict_check_id,
    ...conflict,
  };
}
