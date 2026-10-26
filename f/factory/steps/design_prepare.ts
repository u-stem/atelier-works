// f/factory/designフローの3ステップ中1番目。
// 作業項目の種別、状態、リース(`flow_job_id`がこのフローのジョブID)、承認済みの要件定義、Issueの状態、
// リポジトリのオーナーの数値IDを確かめ、設計の試行を保存してから、設計書が読む専用のdetachedなworktreeを
// `/workspaces/<owner>/<repo>/design-<issue_number>`に作り直す。
// 要件定義用の`req-<N>`は、要件定義の承認の反映が消すので、共有しない。
// 作業項目とworktreeに触れるのは、リースを確かめた後だけ。リースを持たない実行は、何も書かず何も消さずに終わる。

import * as wmill from "windmill-client@1.817.0";
import { isRequirementsApprovedForAttempt } from "../lib/approval_gate.ts";
import { loadConfig } from "../lib/config.ts";
import {
  addNoticeUnlessUnresolved,
  getWorkItem,
  latestRequirementsApproval,
  setDesignAttemptIfLeaseHolder,
  updateStatusIfLeaseHolder,
} from "../lib/db.ts";
import {
  buildDesignWorktreeDir,
  designNoApprovalReason,
} from "../lib/design_template.ts";
import { notifyBestEffort } from "../lib/discord.ts";
import { openFactoryClone } from "../lib/factory_clone.ts";
import { type GhClient, getIssue } from "../lib/github.ts";
import { rootFlowJobId } from "../lib/implement_launch_support.ts";
import { logger } from "../lib/log.ts";
import {
  awaitPipelineLease,
  holdsPipelineLease,
  PIPELINE_LEASE_LOST_REASON,
  PIPELINE_LEASE_POLL_MS,
  PIPELINE_LEASE_WAIT_MS,
} from "../lib/pipeline_lease.ts";
import {
  defaultLockReleaseDeps,
  ensureWorktreeLockFree,
  type LockReleaseDeps,
  worktreeLockFor,
} from "../lib/process_lock.ts";
import {
  repoOwnerGateDeps,
  verifyRepoOwnerId,
} from "../lib/repo_owner_gate.ts";
import { TERMINAL_WORK_ITEM_STATUSES, type WorkItem } from "../lib/types.ts";
import {
  addDetachedWorktree,
  type CommandRunner,
  ensureRepo,
  listWorktrees,
  pathExists,
  removeWorktree,
  resolveDefaultBranchHeadSha,
  runCommand,
} from "../lib/workspace.ts";
import { designNeedsHumanFields } from "./pr_workflow_support.ts";

export type DesignPrepareResult =
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
 * 状態の比較交換が一致しなかったときの理由。
 * 準備の途中でリースが別の実行に移ったか、reconcileなどが作業項目を先へ進めた。
 */
export const DESIGN_PREPARE_MOVED_ON_REASON =
  "work item status or flow_job_id changed during design prepare";

/** 設計のworktreeの操作。 */
export type DesignWorktreeOps = {
  /** `dir`がworktreeとして登録されているか、ディスクに残っているかを返す。 */
  readonly exists: (repoDir: string, dir: string) => Promise<boolean>;
  /** `dir`を前の実行のプロセスが使っていないことを確かめる。使っていれば例外を投げる。 */
  readonly ensureLockFree: (dir: string) => Promise<void>;
  readonly remove: (repoDir: string, dir: string) => Promise<void>;
  readonly add: (repoDir: string, dir: string, sha: string) => Promise<void>;
};

export type DesignPrepareDeps = {
  /** このフローのルートジョブID。リースの値。 */
  readonly leaseJobId: string;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly leaseWaitMs: number;
  readonly leasePollMs: number;
  readonly getWorkItem: (id: number) => Promise<WorkItem | null>;
  /** 作業項目の最新の要件定義の承認(`latestRequirementsApproval`)。 */
  readonly latestRequirementsApproval: (
    id: number,
  ) => Promise<{ readonly status: string; readonly attempt: number } | null>;
  /**
   * リースを条件にした比較交換で、作業項目を`designing`から`to`へ移す。
   * 一致しなければ`false`を返す。
   */
  readonly moveFromDesigning: (
    to: "needs_human" | "cancelled",
    reason: string,
  ) => Promise<boolean>;
  /** リポジトリのオーナーの数値IDを`owners`と照合する(`verifyRepoOwnerId`)。 */
  readonly verifyRepoOwner: (
    owner: string,
    repo: string,
  ) => Promise<
    { readonly ok: true } | { readonly ok: false; readonly reason: string }
  >;
  readonly getIssueState: (
    owner: string,
    repo: string,
    issueNumber: number,
  ) => Promise<string>;
  /** リースを条件にした比較交換で、設計の試行を保存する。一致しなければ`false`を返す。 */
  readonly setDesignAttempt: (designAttempt: number) => Promise<boolean>;
  /** Factory自身のcloneと、対象リポジトリのmainのcloneを用意し、既定ブランチの先頭のshaを求める。 */
  readonly prepareRepo: (
    owner: string,
    repo: string,
  ) => Promise<{ readonly repoDir: string; readonly headSha: string }>;
  readonly worktrees: DesignWorktreeOps;
  /** 人にDiscordで知らせる。届かなくても、状態は記録済みなので失敗にしない。 */
  readonly notifyNeedsHuman: (item: WorkItem, reason: string) => Promise<void>;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
};

/** 状態の比較交換が一致しなかったことをログに残し、何も書かずに終える結果を返す。 */
function movedOn(
  deps: DesignPrepareDeps,
  workItemId: number,
): DesignPrepareResult {
  deps.log("work item moved on during design prepare, skipping", {
    work_item_id: workItemId,
    lease_job_id: deps.leaseJobId,
  });
  return { skip: true, reason: DESIGN_PREPARE_MOVED_ON_REASON };
}

/**
 * 作業項目を検証し、設計フローのリースを確かめてから作業領域を用意する。
 * リースは起動側が`flow_job_id`に記録したこのフローのジョブIDで、
 * 記録を`leaseWaitMs`まで待っても確かめられなければ、何も書かずに`skip`を返す。
 * 失敗扱いにしないのは、別の実行が持ち主なら作業項目はその実行が進めるからである。
 *
 * 順序は次のとおり。どの段階も、リースを条件にした比較交換でしか作業項目を動かさず、
 * 一致しなければ何も書かずに`skip`を返す。
 * 1. 種別と終端を検査する。作業項目が無い、種別がissueでない、Issue番号が無いときは例外を投げる。
 * 2. リースを待つ。確かめた時点で`designing`でなければ`skip`する。
 * 3. 現在の試行に一致する承認済みの要件定義が無ければ`needs_human`にして人に知らせる。
 * 4. リポジトリのオーナーの数値IDを照合する。通らなければ`needs_human`にして人に知らせる。
 * 5. Issueが閉じていれば取り消す。worktreeにはまだ触れていない。
 * 6. 設計の試行を保存し、リポジトリのcloneを用意する。
 * 7. リースと`designing`の状態をもう一度確かめ、どちらも保たれているときだけ、前の`design-<N>`のworktreeを作り直す。
 *    前の実行のプロセスが使っていれば消さずに例外を投げる。
 */
export async function runDesignPrepare(
  deps: DesignPrepareDeps,
  input: { readonly work_item_id: number; readonly design_attempt: number },
): Promise<DesignPrepareResult> {
  const { work_item_id: workItemId } = input;
  const workItem = await deps.getWorkItem(workItemId);
  if (workItem === null) {
    throw new Error(`design_prepare: no work item with id ${workItemId}`);
  }
  if (workItem.kind !== "issue") {
    throw new Error(
      `design_prepare: work item ${workItemId} has kind "${workItem.kind}", expected "issue"`,
    );
  }
  if (TERMINAL_WORK_ITEM_STATUSES.includes(workItem.status)) {
    deps.log("work item already terminal, skipping", {
      work_item_id: workItemId,
      status: workItem.status,
    });
    return { skip: true, reason: `already_terminal:${workItem.status}` };
  }
  const issueNumber = workItem.issue_number;
  if (issueNumber === null) {
    throw new Error(
      `design_prepare: work item ${workItemId} has no issue_number`,
    );
  }

  // 取り消しに失敗して残った古い実行が、同じdesign-<N>のworktreeや状態を書き換えないよう、
  // 作業項目とworktreeに触れる前にリースを確かめる。
  const lease = await awaitPipelineLease({
    readItem: () => deps.getWorkItem(workItemId),
    jobId: deps.leaseJobId,
    now: deps.now,
    sleep: deps.sleep,
    timeoutMs: deps.leaseWaitMs,
    pollMs: deps.leasePollMs,
  });
  if (!lease.held) {
    deps.log("design lease not held, skipping", {
      work_item_id: workItemId,
      status: lease.item?.status ?? null,
      flow_job_id: lease.item?.flow_job_id ?? null,
      lease_job_id: deps.leaseJobId,
    });
    return { skip: true, reason: PIPELINE_LEASE_LOST_REASON };
  }
  const leased = lease.item;
  if (leased.status !== "designing") {
    deps.log("work item is not designing, skipping", {
      work_item_id: workItemId,
      status: leased.status,
    });
    return { skip: true, reason: `not_designing:${leased.status}` };
  }

  const stopForHuman = async (reason: string): Promise<DesignPrepareResult> => {
    if (!(await deps.moveFromDesigning("needs_human", reason))) {
      return movedOn(deps, workItemId);
    }
    await deps.notifyNeedsHuman(leased, reason);
    return { skip: true, reason };
  };

  // 承認の行が要件定義の承認の唯一の根拠である(`approved`の状態を経由しないため)。
  const approval = await deps.latestRequirementsApproval(workItemId);
  if (!isRequirementsApprovedForAttempt(approval, leased.attempt)) {
    return stopForHuman(designNoApprovalReason(leased.attempt));
  }

  // 対象リポジトリのcloneより前に、オーナーの数値IDを`owners`と照合する。
  // 承認の待ちの間に名前が別の人に渡っていても、そのコードをClaudeに読ませない。
  const ownerGuard = await deps.verifyRepoOwner(leased.owner, leased.repo);
  if (!ownerGuard.ok) return stopForHuman(ownerGuard.reason);

  const issueState = await deps.getIssueState(
    leased.owner,
    leased.repo,
    issueNumber,
  );
  if (issueState !== "open") {
    deps.log("issue no longer open, cancelling", {
      work_item_id: workItemId,
      issue_number: issueNumber,
    });
    if (
      !(await deps.moveFromDesigning(
        "cancelled",
        "issue closed before design started",
      ))
    ) {
      return movedOn(deps, workItemId);
    }
    return { skip: true, reason: "issue_closed" };
  }

  // 途中で失敗した実行でも値が正しく残るよう、失敗しうるリポジトリやworktreeの操作より前に保存する。
  if (!(await deps.setDesignAttempt(input.design_attempt))) {
    return movedOn(deps, workItemId);
  }

  const repo = await deps.prepareRepo(leased.owner, leased.repo);

  // 長い操作の間にリースが移っていれば、持ち主のworktreeを消さないよう、触れる前に確かめ直す。
  const current = await deps.getWorkItem(workItemId);
  // 状態が`designing`のままであることも確かめる。リースが残っていても、別の経路が先へ進めていれば手を出さない。
  if (
    current === null ||
    !holdsPipelineLease(current, deps.leaseJobId) ||
    current.status !== "designing"
  ) {
    deps.log("design lease lost during prepare, skipping", {
      work_item_id: workItemId,
      status: current?.status ?? null,
      flow_job_id: current?.flow_job_id ?? null,
      lease_job_id: deps.leaseJobId,
    });
    return { skip: true, reason: PIPELINE_LEASE_LOST_REASON };
  }

  const worktreeDir = buildDesignWorktreeDir(
    leased.owner,
    leased.repo,
    issueNumber,
  );
  if (await deps.worktrees.exists(repo.repoDir, worktreeDir)) {
    // 前の実行のClaudeや検査のプロセスが使っているworktreeを消さない。
    await deps.worktrees.ensureLockFree(worktreeDir);
    await deps.worktrees.remove(repo.repoDir, worktreeDir);
  }
  await deps.worktrees.add(repo.repoDir, worktreeDir, repo.headSha);

  return {
    skip: false,
    worktree_dir: worktreeDir,
    owner: leased.owner,
    repo: leased.repo,
    issue_number: issueNumber,
    head_sha: repo.headSha,
  };
}

/**
 * `dir`を前の実行のプロセスが使っていないことを確かめる。使っていれば`WorktreeBusyError`を投げる。
 * 何も止めない。使用中のworktreeを消さないためである。
 */
export async function ensureDesignWorktreeLockFree(
  dir: string,
  deps: { readonly run: CommandRunner; readonly lockDeps: LockReleaseDeps },
): Promise<void> {
  await ensureWorktreeLockFree({
    run: deps.run,
    lock: worktreeLockFor(dir),
    policy: null,
    deps: deps.lockDeps,
  });
}

/**
 * 設計の準備ステップ。本番の依存を組み立てて`runDesignPrepare`を呼ぶ。
 * フローのルートジョブIDを得られないときは例外を投げる。
 */
export async function main(
  work_item_id: number,
  design_attempt: number,
): Promise<DesignPrepareResult> {
  const log = logger("design_prepare");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };
  const leaseJobId = rootFlowJobId(process.env);

  return runDesignPrepare(
    {
      leaseJobId,
      now: () => Date.now(),
      sleep: (ms) => Bun.sleep(ms),
      leaseWaitMs: PIPELINE_LEASE_WAIT_MS,
      leasePollMs: PIPELINE_LEASE_POLL_MS,
      getWorkItem: (id) => getWorkItem(id),
      latestRequirementsApproval: (id) => latestRequirementsApproval(id),
      moveFromDesigning: (to, reason) =>
        updateStatusIfLeaseHolder(
          work_item_id,
          "designing",
          to,
          leaseJobId,
          reason,
        ),
      verifyRepoOwner: (owner, repo) =>
        verifyRepoOwnerId(
          config,
          owner,
          repo,
          repoOwnerGateDeps(client, addNoticeUnlessUnresolved),
        ),
      getIssueState: async (owner, repo, issueNumber) =>
        (await getIssue(client, owner, repo, issueNumber)).state,
      setDesignAttempt: (designAttempt) =>
        setDesignAttemptIfLeaseHolder(work_item_id, designAttempt, leaseJobId),
      prepareRepo: async (owner, repo) => {
        await openFactoryClone(config, { run: runCommand, ghToken });
        const cloned = await ensureRepo({
          run: runCommand,
          owner,
          repo,
          ghToken,
        });
        return {
          repoDir: cloned.dir,
          headSha: await resolveDefaultBranchHeadSha(runCommand, cloned.dir),
        };
      },
      worktrees: {
        exists: async (repoDir, dir) =>
          (await pathExists(dir)) ||
          (await listWorktrees({ run: runCommand, repoDir })).some(
            (entry) => entry.path === dir,
          ),
        ensureLockFree: (dir) =>
          ensureDesignWorktreeLockFree(dir, {
            run: runCommand,
            lockDeps: defaultLockReleaseDeps(),
          }),
        remove: (repoDir, dir) =>
          removeWorktree({ run: runCommand, repoDir, dir, force: true }),
        add: async (repoDir, dir, sha) => {
          await addDetachedWorktree({
            run: runCommand,
            repoDir,
            sha,
            dir,
            ghToken,
          });
        },
      },
      notifyNeedsHuman: async (item, reason) => {
        await notifyBestEffort(
          await wmill.getVariable("f/factory/discord_webhook_url"),
          {
            kind: "needs_human",
            instance_name: config.instance_name,
            owner: item.owner,
            repo: item.repo,
            url: item.issue_url ?? "",
            ...designNeedsHumanFields(reason),
            target: { kind: "issue", number: item.issue_number ?? 0 },
          },
          log,
        );
      },
      log: (message, fields) => log.warn(message, fields),
    },
    { work_item_id, design_attempt },
  );
}
