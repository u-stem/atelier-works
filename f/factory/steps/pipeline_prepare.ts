// f/factory/pipelineフローの4ステップ中1番目。
// work itemと設定を読み、factory自身のcloneと、
// 対象リポジトリのfetchだけを行うmainのcloneを用意する。
// デフォルトブランチのheadのshaを求め、要件生成ステージが読む
// 読み取り専用のdetachedのworktreeを
// `/workspaces/<owner>/<repo>/req-<issue_number>`に作る(既存なら再利用する)。
// `requirements_generating`に進める前に、Issueがまだopenかを確かめ直す。
// 確保からこのフローの開始までの間に、`poll_issues`のreconcileが
// work itemを取り消している場合があるため。

import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "../lib/config.ts";
import { getWorkItem, setAttempt, updateStatus } from "../lib/db.ts";
import { type GhClient, getIssue } from "../lib/github.ts";
import { logger } from "../lib/log.ts";
import type { WorkItemStatus } from "../lib/types.ts";
import { TERMINAL_WORK_ITEM_STATUSES } from "../lib/types.ts";
import {
  addDetachedWorktree,
  ensureFactoryClone,
  ensureRepo,
  listWorktrees,
  removeWorktree,
  resolveDefaultBranchHeadSha,
  runCommand,
  type WorktreeEntry,
} from "../lib/workspace.ts";

export type PipelinePrepareResult =
  | { readonly skip: true; readonly reason: string }
  | {
      readonly skip: false;
      readonly worktree_dir: string;
      readonly owner: string;
      readonly repo: string;
      readonly issue_number: number;
      readonly head_sha: string;
    };

/**
 * work itemが終了状態に達しているかを返す。テストできるよう純粋関数にしている。
 * 終了済みなら再開せずに飛ばす。並行する`poll_issues`のreconcileや、
 * 前回の`requirements_apply.ts`の実行が、すでに終わらせている場合があるため。
 */
export function isAlreadyTerminal(status: WorkItemStatus): boolean {
  return TERMINAL_WORK_ITEM_STATUSES.includes(status);
}

/**
 * 1つのIssueの要件を生成するための、読み取り専用のdetachedのworktreeのパスを返す。
 * このファイルが作成と再利用に、`requirements_apply.ts`が最後の削除に使うため、
 * 両者で同じパスになるようここに一本化している。
 */
export function buildRequirementsWorktreeDir(
  owner: string,
  repo: string,
  issueNumber: number,
): string {
  return `/workspaces/${owner}/${repo}/req-${issueNumber}`;
}

/**
 * `entries`から、パスが`worktreeDir`のworktreeを探して返す。
 * まだ登録されていなければ`undefined`を返す。
 */
export function findWorktreeEntry(
  entries: readonly WorktreeEntry[],
  worktreeDir: string,
): WorktreeEntry | undefined {
  return entries.find((entry) => entry.path === worktreeDir);
}

/**
 * 登録済みのworktreeをそのまま再利用できるかを返す。
 * 再利用するのは、worktreeが存在し、かつ対象リポジトリの
 * 現在のデフォルトブランチのhead(`headSha`)をcheckoutしているときだけ。
 * パスが一致するだけで再利用すると、デフォルトブランチが進む前や
 * 古いattemptで作られたworktreeが古いコミットを指したまま気づかないうちに使われ、
 * Claudeが古いコードを読んで要件を書いてしまう。
 * パスが一致してもshaが違うものは古いとみなし、`main`が削除して作り直す。
 */
export function shouldReuseWorktree(
  entry: WorktreeEntry | undefined,
  headSha: string,
): boolean {
  return entry !== undefined && entry.headSha === headSha;
}

/**
 * Issueの現在の状態から、このpipelineの実行を進めずに取り消すべきかを返す。
 * 確保からこのフローの開始までの間にIssueが閉じられても、
 * `poll_issues`のreconcileが見逃している場合があるため、ここでも確かめる。
 */
export function shouldCancelForClosedIssue(issueState: string): boolean {
  return issueState !== "open";
}

export async function main(
  work_item_id: number,
  attempt: number,
): Promise<PipelinePrepareResult> {
  const log = logger("pipeline_prepare");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };

  const workItem = await getWorkItem(work_item_id);
  if (workItem === null) {
    throw new Error(`pipeline_prepare: no work item with id ${work_item_id}`);
  }
  if (workItem.kind !== "issue") {
    throw new Error(
      `pipeline_prepare: work item ${work_item_id} has kind "${workItem.kind}", expected "issue"`,
    );
  }
  if (isAlreadyTerminal(workItem.status)) {
    log.info("work item already terminal, skipping", {
      work_item_id,
      status: workItem.status,
    });
    return { skip: true, reason: `already_terminal:${workItem.status}` };
  }
  if (workItem.issue_number === null) {
    throw new Error(
      `pipeline_prepare: work item ${work_item_id} has no issue_number`,
    );
  }

  // `retry_work_item.ts`などは`work_items.attempt`を読んで次のattemptを決める。
  // 途中で失敗した実行でも値が正しく残るよう、work itemの検証直後、
  // 失敗しうるリポジトリやworktreeの操作より前に保存する。
  await setAttempt(work_item_id, attempt);

  await ensureFactoryClone({
    run: runCommand,
    repoUrl: config.factory_repo,
    ghToken,
    branch: config.factory_branch,
  });

  const repo = await ensureRepo({
    run: runCommand,
    owner: workItem.owner,
    repo: workItem.repo,
    ghToken,
  });

  const headSha = await resolveDefaultBranchHeadSha(runCommand, repo.dir);

  const worktreeDir = buildRequirementsWorktreeDir(
    workItem.owner,
    workItem.repo,
    workItem.issue_number,
  );
  const existing = await listWorktrees({ run: runCommand, repoDir: repo.dir });
  const existingEntry = findWorktreeEntry(existing, worktreeDir);
  if (shouldReuseWorktree(existingEntry, headSha)) {
    log.info("reusing existing requirements worktree", { worktreeDir });
  } else {
    if (existingEntry !== undefined) {
      log.info("existing requirements worktree is stale, recreating", {
        worktreeDir,
        staleHeadSha: existingEntry.headSha,
        currentHeadSha: headSha,
      });
      await removeWorktree({
        run: runCommand,
        repoDir: repo.dir,
        dir: worktreeDir,
        force: true,
      });
    }
    await addDetachedWorktree({
      run: runCommand,
      repoDir: repo.dir,
      sha: headSha,
      dir: worktreeDir,
      ghToken,
    });
  }

  const issue = await getIssue(
    client,
    workItem.owner,
    workItem.repo,
    workItem.issue_number,
  );
  if (shouldCancelForClosedIssue(issue.state)) {
    log.info("issue no longer open, cancelling", {
      work_item_id,
      issue_number: workItem.issue_number,
    });
    await updateStatus(
      work_item_id,
      "cancelled",
      "issue closed before pipeline started",
    );
    await removeWorktree({
      run: runCommand,
      repoDir: repo.dir,
      dir: worktreeDir,
      force: true,
    });
    return { skip: true, reason: "issue_closed" };
  }

  await updateStatus(work_item_id, "requirements_generating", null);

  return {
    skip: false,
    worktree_dir: worktreeDir,
    owner: workItem.owner,
    repo: workItem.repo,
    issue_number: workItem.issue_number,
    head_sha: headSha,
  };
}
