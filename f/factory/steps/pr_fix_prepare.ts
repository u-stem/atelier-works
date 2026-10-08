// f/factory/pr_fixの準備ステップ。
// 修正を始めてよいかを検査し、通ればPRのheadブランチのworktreeを用意する。

import * as wmill from "windmill-client@1.817.0";
import { isRepoAllowed, loadConfig } from "../lib/config.ts";
import { getWorkItem } from "../lib/db.ts";
import { type GhClient, getBranchProtected, getPr } from "../lib/github.ts";
import { parseImplementBranchWorkItemId } from "../lib/implement_support.ts";
import {
  defaultLockReleaseDeps,
  ensureWorktreeLockFree,
  WorktreeBusyError,
  worktreeLockFor,
} from "../lib/process_lock.ts";
import { assertGitHubName } from "../lib/types.ts";
import {
  createGtrWorktree,
  ensureFactoryClone,
  ensureRepo,
  type GtrWorktree,
  runCommand,
} from "../lib/workspace.ts";
import {
  earlyExitBase,
  evaluateBranchImplementingGuard,
  evaluateFixRoundGuard,
  evaluateParentImplementingGuard,
  evaluatePrFixSafetyGuards,
  evaluateRepoAllowedGuard,
  type PrFixGateOutcome,
  prFixTimeoutMisfit,
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
  readonly parent_work_item_id: number | null;
  readonly attempt: number;
  readonly fix_round: number;
};

/**
 * 作業項目を読み、修正ラウンドの上限、対象リポジトリの許可、
 * 時間設定が修正・検証ステップのtimeoutに収まること、
 * 親Issueの再実装中でないこと、PRの安全条件
 * (open、headとbaseが同じリポジトリ、draftでない、baseブランチが保護されていない)
 * を順に検査する。
 * 検査に通らなければ`outcome`に理由を入れて返し、worktreeは作らない。
 * すべて通ったときだけ、Factoryのself cloneと対象リポジトリのcloneを用意し、
 * PRのheadブランチに`git gtr`のworktreeを作る。
 * detachedではなく実ブランチのworktreeにするのは、
 * `commitAndPush`がそのブランチへpushし直すため。
 * PRのブランチ名から引いた実装の作業項目が`implementing`なら`guard_blocked`を返す。
 * worktreeを前の実行のプロセスがまだ使っていれば、何も止めずに保持者を理由に載せて`guard_blocked`を返す。
 * 作業項目が無い、またはPR番号が無いときは例外を投げる。
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

  const roundGuard = evaluateFixRoundGuard(
    workItem.fix_round,
    config.max_fix_rounds,
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
  const timeoutMisfit = prFixTimeoutMisfit(config);
  if (timeoutMisfit !== null) {
    return {
      outcome: "guard_blocked",
      reason: timeoutMisfit,
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

  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };

  const pr = await getPr(
    client,
    workItem.owner,
    workItem.repo,
    workItem.pr_number,
  );
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
  const baseProtected = await getBranchProtected(
    client,
    workItem.owner,
    workItem.repo,
    pr.baseRef,
  );

  const safety = evaluatePrFixSafetyGuards({
    open: pr.state === "open",
    headRepoFullName: pr.headRepoFullName,
    baseRepoFullName: pr.baseRepoFullName,
    draft: pr.draft,
    baseProtected,
  });
  if (!safety.ok) {
    return {
      outcome: "guard_blocked",
      reason: safety.reason,
      ...earlyExitBase(workItem),
    };
  }

  const factoryClone = await ensureFactoryClone({
    run: runCommand,
    repoUrl: config.factory_repo,
    ghToken,
    branch: config.factory_branch,
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
    throw err;
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
    parent_work_item_id: workItem.parent_work_item_id,
    attempt: workItem.attempt,
    fix_round: workItem.fix_round,
  };
}
