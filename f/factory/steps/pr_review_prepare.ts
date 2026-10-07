// f/factory/pr_reviewフローの準備ステップ。
// 作業項目がまだ`reviewing`状態の有効なpr_reviewかを確かめ、
// 古い・取り消された作業項目なら処理せずに飛ばす。
// fetchだけを行うmainのcloneと、PRのheadコミットを指すdetachedのworktreeを用意する。
// pr_reviewはmainのcloneでは作業ツリーをcheckoutしない。
// worktreeを作る間にheadのshaが動いていないかを、最後にもう一度確かめる。

import * as wmill from "windmill-client@1.817.0";
import { isRepoAllowed, loadConfig } from "../lib/config.ts";
import { getWorkItem, setHeadSha } from "../lib/db.ts";
import { type GhClient, getPr } from "../lib/github.ts";
import { assertGitHubName, assertSha } from "../lib/types.ts";
import {
  addDetachedWorktree,
  ensureFactoryClone,
  ensureRepo,
  fetchPrHeadRef,
  runCommand,
} from "../lib/workspace.ts";
import { decideReviewPrepare } from "./pr_workflow_support.ts";

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

export async function main(
  work_item_id: number,
): Promise<PrReviewPrepareResult> {
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

  await fetchPrHeadRef(runCommand, repoDir, workItem.pr_number, ghToken);

  const prBeforeWorktree = await getPr(
    client,
    workItem.owner,
    workItem.repo,
    workItem.pr_number,
  );
  assertSha(prBeforeWorktree.headSha);

  const sha7 = prBeforeWorktree.headSha.slice(0, 7);
  const worktreeDir = buildReviewWorktreeDir(repoDir, workItem.pr_number, sha7);

  await addDetachedWorktree({
    run: runCommand,
    repoDir,
    sha: prBeforeWorktree.headSha,
    dir: worktreeDir,
    ghToken,
  });

  // 上の`getPr`から今までにPRへ新しいコミットが積まれている場合がある。
  // そのときは新しい`head_sha`を保存するが、レビューはcheckout済みのshaのまま続ける。
  // 新しいコミットは、次の`poll_prs`の周期で別のレビューとして拾われる
  // (1コミットにつき1レビュー)。
  const prAfterWorktree = await getPr(
    client,
    workItem.owner,
    workItem.repo,
    workItem.pr_number,
  );
  if (prAfterWorktree.headSha !== prBeforeWorktree.headSha) {
    await setHeadSha(work_item_id, prAfterWorktree.headSha);
  }

  return {
    skip: false,
    reason: null,
    owner: workItem.owner,
    repo: workItem.repo,
    pr_number: workItem.pr_number,
    review_sha: prBeforeWorktree.headSha,
    repo_dir: repoDir,
    worktree_dir: worktreeDir,
    factory_clone_dir: factoryClone.dir,
    parent_work_item_id: workItem.parent_work_item_id,
    attempt: workItem.attempt,
  };
}
