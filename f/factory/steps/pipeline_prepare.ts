// f/factory/pipelineフローの3ステップ中1番目。
// 作業項目と設定を読み、リポジトリのオーナーの数値IDを`owners`と照合してから、Factory自身のcloneと、
// 対象リポジトリのfetchだけを行うmainのcloneを用意する。
// デフォルトブランチのheadのshaを求め、要件生成ステージが読む
// 読み取り専用のdetachedのworktreeを
// `/workspaces/<owner>/<repo>/req-<issue_number>`に作る(既存なら再利用する)。
// `requirements_generating`に進める前に、Issueがまだopenかを確かめ直す。
// 確保からこのフローの開始までの間に、`poll_issues`のreconcileが
// 作業項目を取り消している場合があるため。
// 作業項目に触れるのは、`flow_job_id`にこのフローのジョブIDが記録されているとき(pipelineのリース)だけ。

import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "../lib/config.ts";
import {
  addNoticeUnlessUnresolved,
  getWorkItem,
  setAttemptIfLeaseHolder,
  updateStatusIfLeaseHolder,
} from "../lib/db.ts";
import { notifyBestEffort } from "../lib/discord.ts";
import { openFactoryClone } from "../lib/factory_clone.ts";
import { type GhClient, getIssue } from "../lib/github.ts";
import { rootFlowJobId } from "../lib/implement_launch_support.ts";
import { logger } from "../lib/log.ts";
import {
  awaitPipelineLease,
  PIPELINE_LEASE_LOST_REASON,
  PIPELINE_LEASE_POLL_MS,
  PIPELINE_LEASE_WAIT_MS,
} from "../lib/pipeline_lease.ts";
import {
  repoOwnerGateDeps,
  verifyRepoOwnerId,
} from "../lib/repo_owner_gate.ts";
import type { WorkItemStatus } from "../lib/types.ts";
import { TERMINAL_WORK_ITEM_STATUSES } from "../lib/types.ts";
import {
  addDetachedWorktree,
  ensureRepo,
  listWorktrees,
  removeWorktree,
  resolveDefaultBranchHeadSha,
  runCommand,
  type WorktreeEntry,
} from "../lib/workspace.ts";
import { describeReason, nextActionFor } from "./pr_workflow_support.ts";

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
 * 作業項目が終了状態に達しているかを返す。テストできるよう純粋関数にしている。
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

/**
 * 状態の比較交換が一致しなかったときの理由。
 * 準備の途中でリースが別の実行に移ったか、reconcileなどが作業項目を先へ進めた。
 */
export const PIPELINE_PREPARE_MOVED_ON_REASON =
  "work item status or flow_job_id changed during prepare";

export type RepoOwnerStopDeps = {
  /** リースを条件にした比較交換で、作業項目を`needs_human`にする。一致しなければ`false`。 */
  readonly moveToNeedsHuman: (reason: string) => Promise<boolean>;
  /** 人にDiscordで知らせる。届かなくても、状態は記録済みなので失敗にしない。 */
  readonly notify: (reason: string) => Promise<void>;
};

/**
 * リポジトリのオーナーの数値IDの照合に通らなかった作業項目を、`needs_human`にして終える。
 * 準備のほかのステップが`isRepoAllowed`を偽と見たときに終える扱いに合わせて、
 * 作業領域は用意せず、後続のステップは`skip`で飛ばす。
 * 状態の比較交換が一致しなければ、何も書かず通知せずに、`movedOn`と同じ結果を返す。
 */
export async function stopForRepoOwner(
  reason: string,
  deps: RepoOwnerStopDeps,
): Promise<PipelinePrepareResult> {
  if (!(await deps.moveToNeedsHuman(reason))) {
    return { skip: true, reason: PIPELINE_PREPARE_MOVED_ON_REASON };
  }
  await deps.notify(reason);
  return { skip: true, reason };
}

/** 状態の比較交換が一致しなかったことをログに残し、何も書かずに終える結果を返す。 */
function movedOn(
  workItemId: number,
  leaseJobId: string,
): PipelinePrepareResult {
  logger("pipeline_prepare").warn(
    "work item moved on during prepare, skipping",
    {
      work_item_id: workItemId,
      lease_job_id: leaseJobId,
    },
  );
  return { skip: true, reason: PIPELINE_PREPARE_MOVED_ON_REASON };
}

/**
 * 作業項目を検証し、pipelineのリースを確かめてから作業領域を用意する。
 * リースは起動側が`flow_job_id`に記録したこのフローのジョブIDで、
 * 記録を`PIPELINE_LEASE_WAIT_MS`まで待っても確かめられなければ、何も書かずに`skip`を返す。
 * 失敗扱いにしないのは、別の実行が持ち主なら作業項目はその実行が進めるからである。
 * 状態の書き換えは、リースを確かめた時点の状態と`flow_job_id`のままのときだけ行う比較交換で、
 * 一致しなければ状態を書き換えずに`skip`を返す(attemptの保存とworktreeの用意は済んでいる)。
 * リースを確かめて`attempt`を保存した後、リポジトリをcloneする前に、
 * リポジトリのオーナーの数値IDを`owners`と照合する(`verifyRepoOwnerId`)。
 * 通らなければ、作業項目を`needs_human`にして人に知らせ、作業領域を用意せずに`skip`を返す(`stopForRepoOwner`)。
 * 作業項目が無い、種類がissueでない、Issue番号が無い、フローのルートジョブIDを得られないときは例外を投げる。
 */
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
  const issueNumber = workItem.issue_number;
  if (issueNumber === null) {
    throw new Error(
      `pipeline_prepare: work item ${work_item_id} has no issue_number`,
    );
  }

  // 取り消しに失敗して残った古い実行が、同じreq-<N>のworktreeや状態を書き換えないよう、
  // 作業項目とworktreeに触れる前にリースを確かめる。
  const leaseJobId = rootFlowJobId(process.env);
  const lease = await awaitPipelineLease({
    readItem: () => getWorkItem(work_item_id),
    jobId: leaseJobId,
    now: () => Date.now(),
    sleep: (ms) => Bun.sleep(ms),
    timeoutMs: PIPELINE_LEASE_WAIT_MS,
    pollMs: PIPELINE_LEASE_POLL_MS,
  });
  if (!lease.held) {
    log.warn("pipeline lease not held, skipping", {
      work_item_id,
      status: lease.item?.status ?? null,
      flow_job_id: lease.item?.flow_job_id ?? null,
      lease_job_id: leaseJobId,
    });
    return { skip: true, reason: PIPELINE_LEASE_LOST_REASON };
  }
  const leasedStatus = lease.item.status;

  // `retry_work_item.ts`などは`work_items.attempt`を読んで次のattemptを決める。
  // 途中で失敗した実行でも値が正しく残るよう、リースを確かめた直後、
  // 失敗しうるリポジトリやworktreeの操作より前に保存する。
  if (!(await setAttemptIfLeaseHolder(work_item_id, attempt, leaseJobId)))
    return movedOn(work_item_id, leaseJobId);

  // 対象リポジトリのcloneより前に、オーナーの数値IDを`owners`と照合する。
  // 承認の差し戻しや再実行の間に名前が別の人に渡っていても、そのコードをClaudeに読ませない。
  const ownerGuard = await verifyRepoOwnerId(
    config,
    workItem.owner,
    workItem.repo,
    repoOwnerGateDeps(client, addNoticeUnlessUnresolved),
  );
  if (!ownerGuard.ok) {
    return stopForRepoOwner(ownerGuard.reason, {
      moveToNeedsHuman: (reason) =>
        updateStatusIfLeaseHolder(
          work_item_id,
          leasedStatus,
          "needs_human",
          leaseJobId,
          reason,
        ),
      notify: async (reason) => {
        await notifyBestEffort(
          await wmill.getVariable("f/factory/discord_webhook_url"),
          {
            kind: "needs_human",
            instance_name: config.instance_name,
            owner: workItem.owner,
            repo: workItem.repo,
            url: workItem.issue_url ?? "",
            reason: describeReason(reason),
            target: { kind: "issue", number: issueNumber },
            next_action: nextActionFor(reason),
          },
          log,
        );
      },
    });
  }

  await openFactoryClone(config, {
    run: runCommand,
    ghToken,
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
    issueNumber,
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
    issueNumber,
  );
  if (shouldCancelForClosedIssue(issue.state)) {
    log.info("issue no longer open, cancelling", {
      work_item_id,
      issue_number: issueNumber,
    });
    const cancelled = await updateStatusIfLeaseHolder(
      work_item_id,
      leasedStatus,
      "cancelled",
      leaseJobId,
      "issue closed before pipeline started",
    );
    // 一致しなければworktreeは今の持ち主が使っているかもしれないので、消さずに終わる。
    if (!cancelled) return movedOn(work_item_id, leaseJobId);
    await removeWorktree({
      run: runCommand,
      repoDir: repo.dir,
      dir: worktreeDir,
      force: true,
    });
    return { skip: true, reason: "issue_closed" };
  }

  const started = await updateStatusIfLeaseHolder(
    work_item_id,
    leasedStatus,
    "requirements_generating",
    leaseJobId,
    null,
  );
  if (!started) return movedOn(work_item_id, leaseJobId);

  return {
    skip: false,
    worktree_dir: worktreeDir,
    owner: workItem.owner,
    repo: workItem.repo,
    issue_number: issueNumber,
    head_sha: headSha,
  };
}
