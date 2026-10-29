// f/factory/pr_reviewフローの準備ステップ。
// 作業項目がまだ`reviewing`状態の有効なpr_reviewかを確かめ、
// 古い・取り消された作業項目なら処理せずに飛ばす。
// fetchだけを行うmainのcloneと、PRのheadコミットを指すdetachedのworktreeを用意する。
// pr_reviewはmainのcloneでは作業ツリーをcheckoutしない。
// worktreeを作る間にheadのshaが動いていないかを、最後にもう一度確かめる。

import * as wmill from "windmill-client@1.817.0";
import { isDesignStage, readBranchItemStatus } from "../lib/branch_hold.ts";
import { isRepoAllowed, loadConfig } from "../lib/config.ts";
import {
  addNoticeUnlessUnresolved,
  getWorkItem,
  setHeadSha,
  updateStatusIfCurrent,
} from "../lib/db.ts";
import { type NotifyEvent, notifyBestEffort } from "../lib/discord.ts";
import { openFactoryClone } from "../lib/factory_clone.ts";
import { type GhClient, getPr, type PullRequest } from "../lib/github.ts";
import { logger } from "../lib/log.ts";
import { markTransientGitHubFailure } from "../lib/pr_review_retry.ts";
import {
  type RepoOwnerGateResult,
  repoOwnerGateDeps,
  verifyRepoOwnerId,
} from "../lib/repo_owner_gate.ts";
import {
  assertGitHubName,
  assertSha,
  type WorkItemStatus,
} from "../lib/types.ts";
import {
  addDetachedWorktree,
  ensureRepo,
  fetchPrHeadRef,
  runCommand,
} from "../lib/workspace.ts";
import {
  decideReviewPrepare,
  describeReason,
  evaluateSameRepoHeadGuard,
  nextActionFor,
  REVIEW_DESIGN_STAGE_REASON,
} from "./pr_workflow_support.ts";

export type PrReviewPrepareResult = {
  readonly skip: boolean;
  readonly reason: string | null;
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
  readonly review_sha: string;
  readonly repo_dir: string;
  readonly worktree_dir: string;
  readonly factory_clone_dir: string;
  readonly parent_work_item_id: number | null;
  readonly attempt: number;
};

/**
 * PRの1コミットをレビューするためのdetachedのworktreeのパスを返す。
 * `sha7`はレビュー対象コミットのshaの先頭7文字。
 * このファイルが作成に、`cleanup_workspaces.ts`がTTL切れの削除に使うため、
 * 両者で同じパスになるようここに一本化している。
 */
export function buildReviewWorktreeDir(
  repoDir: string,
  prNumber: number,
  sha7: string,
): string {
  return `${repoDir.replace(/\/main$/, "")}/review-${String(prNumber)}-${sha7}`;
}

const SKIPPED_BASE = {
  owner: "",
  repo: "",
  pr_number: 0,
  review_sha: "",
  repo_dir: "",
  worktree_dir: "",
  factory_clone_dir: "",
  parent_work_item_id: null,
  attempt: 1,
} as const;

/**
 * GitHubの5xxや通信断で落ちたときは、例外の文の先頭に印を付けて投げる(`markTransientGitHubFailure`)。
 * 印の付いた失敗は、`auto_retry_pr_review`が作業項目の状態で自動に再開する。
 */
export async function main(
  work_item_id: number,
): Promise<PrReviewPrepareResult> {
  try {
    return await prepare(work_item_id);
  } catch (err) {
    throw markTransientGitHubFailure(err);
  }
}

async function prepare(work_item_id: number): Promise<PrReviewPrepareResult> {
  const workItem = await getWorkItem(work_item_id);
  if (workItem === null) {
    throw new Error(`pr_review_prepare: no work item with id ${work_item_id}`);
  }

  const decision = decideReviewPrepare(workItem);
  if (decision.skip) {
    return { skip: true, reason: decision.reason, ...SKIPPED_BASE };
  }
  if (workItem.pr_number === null) {
    throw new Error(
      `pr_review_prepare: work item ${work_item_id} has no pr_number`,
    );
  }
  assertGitHubName(workItem.owner);
  assertGitHubName(workItem.repo);

  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );

  // 多層防御のための再確認。`poll_prs.ts`は作業項目を作る前に
  // `filterByRepoAllowlist`で絞っているが、その後に`factory_config`が編集されると、
  // 許可されなくなったリポジトリを指す作業項目が残りうる。
  if (!isRepoAllowed(config, workItem.owner, workItem.repo)) {
    return {
      skip: true,
      reason: `${workItem.owner}/${workItem.repo} is not allowed by factory_config (owners / repo_allowlist)`,
      ...SKIPPED_BASE,
    };
  }

  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };
  const prNumber = workItem.pr_number;

  return prepareReviewWorktree(
    {
      work_item_id,
      owner: workItem.owner,
      repo: workItem.repo,
      pr_number: prNumber,
      parent_work_item_id: workItem.parent_work_item_id,
      attempt: workItem.attempt,
    },
    {
      checkRepoOwner: () =>
        verifyRepoOwnerId(
          config,
          workItem.owner,
          workItem.repo,
          repoOwnerGateDeps(client, addNoticeUnlessUnresolved),
        ),
      getPr: (owner, repo, number) => getPr(client, owner, repo, number),
      ensureFactoryClone: () =>
        openFactoryClone(config, { run: runCommand, ghToken }),
      ensureRepo: (owner, repo) =>
        ensureRepo({ run: runCommand, owner, repo, ghToken }),
      fetchPrHeadRef: (repoDir, number) =>
        fetchPrHeadRef(runCommand, repoDir, number, ghToken),
      addDetachedWorktree: async (input) => {
        await addDetachedWorktree({ run: runCommand, ghToken, ...input });
      },
      setHeadSha,
      readBranchStatus: (headRef) =>
        readBranchItemStatus(
          { headRef, owner: workItem.owner, repo: workItem.repo },
          getWorkItem,
        ),
      holdReview: async (reason) => {
        await updateStatusIfCurrent(
          work_item_id,
          "reviewing",
          "blocked",
          reason,
        );
      },
      blockReview: async (reason) => {
        await blockReview(
          {
            work_item_id,
            owner: workItem.owner,
            repo: workItem.repo,
            pr_number: prNumber,
            instance_name: config.instance_name,
            reason,
          },
          {
            updateStatusIfCurrent,
            notify: async (event) => {
              await notifyBestEffort(
                await wmill.getVariable("f/factory/discord_webhook_url"),
                event,
                logger("pr_review_prepare"),
              );
            },
          },
        );
      },
    },
  );
}

export type BlockReviewInput = {
  readonly work_item_id: number;
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
  readonly instance_name: string;
  readonly reason: string;
};

export type BlockReviewDeps = {
  readonly updateStatusIfCurrent: typeof updateStatusIfCurrent;
  readonly notify: (event: NotifyEvent) => Promise<void>;
};

/**
 * 準備の関門(オーナーの数値IDの照合、forkのPR)で見送った`pr_review`を、
 * 終端の`blocked`にして理由を残し、人にDiscordで知らせる。
 * `pr_fix`の準備の関門(`guard_blocked`)と同じ扱いである。
 * `reviewing`のまま残すと、reconcileが理由の分からない失敗として扱うためである。
 * すでにほかの処理が状態を進めていたときは、何も記録も通知もしない。
 */
export async function blockReview(
  input: BlockReviewInput,
  deps: BlockReviewDeps,
): Promise<void> {
  const moved = await deps.updateStatusIfCurrent(
    input.work_item_id,
    "reviewing",
    "blocked",
    input.reason,
  );
  if (!moved) return;
  await deps.notify({
    kind: "needs_human",
    instance_name: input.instance_name,
    owner: input.owner,
    repo: input.repo,
    url: `https://github.com/${input.owner}/${input.repo}/pull/${String(input.pr_number)}`,
    reason: describeReason(input.reason),
    target: { kind: "pr", number: input.pr_number },
    next_action: nextActionFor(input.reason),
  });
}

export type HoldReviewInput = {
  readonly work_item_id: number;
  readonly reason: string;
};

export type HoldReviewDeps = {
  readonly updateStatusIfCurrent: typeof updateStatusIfCurrent;
};

export async function holdReview(
  _input: HoldReviewInput,
  _deps: HoldReviewDeps,
): Promise<void> {}

export type ReviewPrepareTarget = {
  readonly work_item_id: number;
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
  readonly parent_work_item_id: number | null;
  readonly attempt: number;
};

/** `prepareReviewWorktree`が使う入出力。テストで差し替える。 */
export type ReviewPrepareDeps = {
  /**
   * リポジトリのオーナーの数値IDを、設定の`owners`と照合する(`verifyRepoOwnerId`)。
   * 通らなければ、PRの読み取りより前に止める。
   */
  readonly checkRepoOwner: () => Promise<RepoOwnerGateResult>;
  readonly getPr: (
    owner: string,
    repo: string,
    number: number,
  ) => Promise<PullRequest>;
  readonly ensureFactoryClone: () => Promise<{ readonly dir: string }>;
  readonly ensureRepo: (
    owner: string,
    repo: string,
  ) => Promise<{ readonly dir: string }>;
  readonly fetchPrHeadRef: (repoDir: string, prNumber: number) => Promise<void>;
  readonly addDetachedWorktree: (input: {
    readonly repoDir: string;
    readonly sha: string;
    readonly dir: string;
  }) => Promise<void>;
  readonly setHeadSha: (id: number, sha: string) => Promise<void>;
  /** 準備の関門でPRのレビューを見送るとき、作業項目を終端にして人に知らせる。 */
  readonly blockReview: (reason: string) => Promise<void>;
  /** PRのheadブランチが指す作業項目の状態を返す。引けないときは`null`を返す。 */
  readonly readBranchStatus: (
    headRef: string,
  ) => Promise<WorkItemStatus | null>;
  /** 設計の段階でPRのレビューを始めないとき、通知せずに作業項目を終端にする。 */
  readonly holdReview: (reason: string) => Promise<void>;
};

/**
 * 多層防御のため、まずリポジトリのオーナーの数値IDを設定の`owners`と照合する。
 * 通らないときは、PRの読み取りもcloneもfetchもworktreeの作成もせずに、
 * 作業項目を`blockReview`で終端にして、理由つきで`skip`を返す。
 * 次に、PRのheadがbaseと同じリポジトリにあるかを確かめる。
 * `poll_prs.ts`は、headがbaseと同じリポジトリにないPRのレビューを始めないが、
 * 作業項目を手で追加するなどの経路は止められない。
 * 通らないときは、forkの内容をcloneにもfetchにも入れず、worktreeも作らずに、
 * 同じく作業項目を`blockReview`で終端にして飛ばす。
 * 最後に、PRのheadブランチが指す作業項目が設計の段階にあれば、通知せずに`holdReview`で終端にして飛ばす。
 */
export async function prepareReviewWorktree(
  target: ReviewPrepareTarget,
  deps: ReviewPrepareDeps,
): Promise<PrReviewPrepareResult> {
  const { owner, repo, pr_number } = target;

  const ownerGate = await deps.checkRepoOwner();
  if (!ownerGate.ok) {
    await deps.blockReview(ownerGate.reason);
    return { skip: true, reason: ownerGate.reason, ...SKIPPED_BASE };
  }

  const prForRepoCheck = await deps.getPr(owner, repo, pr_number);
  const sameRepoHead = evaluateSameRepoHeadGuard(
    prForRepoCheck.headRepoFullName,
    prForRepoCheck.baseRepoFullName,
  );
  if (!sameRepoHead.ok) {
    await deps.blockReview(sameRepoHead.reason);
    return { skip: true, reason: sameRepoHead.reason, ...SKIPPED_BASE };
  }

  // ブランチの作業項目が設計の段階にある間は、設計の承認の後の実装が同じブランチを引き継ぎ、実装の完了でレビューが付く。
  // 人の操作は要らないので、通知せずに終端にする。作業項目が引けないときと、ほかの状態では止めない。
  if (isDesignStage(await deps.readBranchStatus(prForRepoCheck.headRef))) {
    await deps.holdReview(REVIEW_DESIGN_STAGE_REASON);
    return { skip: true, reason: REVIEW_DESIGN_STAGE_REASON, ...SKIPPED_BASE };
  }

  const factoryClone = await deps.ensureFactoryClone();
  const { dir: repoDir } = await deps.ensureRepo(owner, repo);

  await deps.fetchPrHeadRef(repoDir, pr_number);

  const prBeforeWorktree = await deps.getPr(owner, repo, pr_number);
  assertSha(prBeforeWorktree.headSha);

  const sha7 = prBeforeWorktree.headSha.slice(0, 7);
  const worktreeDir = buildReviewWorktreeDir(repoDir, pr_number, sha7);

  await deps.addDetachedWorktree({
    repoDir,
    sha: prBeforeWorktree.headSha,
    dir: worktreeDir,
  });

  // 上の`getPr`から今までにPRへ新しいコミットが積まれている場合がある。
  // そのときは新しい`head_sha`を保存するが、レビューはcheckout済みのshaのまま続ける。
  // 新しいコミットは、次の`poll_prs`の周期で別のレビューとして拾われる
  // (1コミットにつき1レビュー)。
  const prAfterWorktree = await deps.getPr(owner, repo, pr_number);
  if (prAfterWorktree.headSha !== prBeforeWorktree.headSha) {
    await deps.setHeadSha(target.work_item_id, prAfterWorktree.headSha);
  }

  return {
    skip: false,
    reason: null,
    owner,
    repo,
    pr_number,
    review_sha: prBeforeWorktree.headSha,
    repo_dir: repoDir,
    worktree_dir: worktreeDir,
    factory_clone_dir: factoryClone.dir,
    parent_work_item_id: target.parent_work_item_id,
    attempt: target.attempt,
  };
}
