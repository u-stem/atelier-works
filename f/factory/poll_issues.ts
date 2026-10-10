// 5分ごとに、`factory_config.owners`のリポジトリで新しく`trigger_label`が
// 付いたIssueを取得して`f/factory/pipeline`を起動し、進行中のすべての
// 作業項目(IssueとPRの両方)をGitHubとWindmillの状態に合わせる。
// 複数インスタンス間の排他は、advisory lockではなくGitHub側の取得だけで行う
// (Issueはassignee、PRはトリガーラベルの消費。どちらも取り直して確かめる)。
// 1つのインスタンス内での重複実行は、スケジュールの`no_flow_overlap: true`で防ぐ。
//
// 判断(どのIssueを取得・見送るか、進行中の作業項目をどうするか)は
// `./lib/poll_support.ts`の純粋関数にあり、このファイルは入出力をつなぐだけ。
// 1件の失敗では例外を投げない(`recordFailureSafe`を参照)。

// デプロイ先のサーバーの版に合わせて1.817.0に固定する。固定しないと
// `generate-metadata`のたびにscriptごとに別の最新版へずれていく。
import * as wmill from "windmill-client@1.817.0";
import { expiredRequirementsRequests } from "./lib/approval_support.ts";
import {
  ACTIVE_WORK_ITEM_EXISTS_REASON,
  recordAssigneeMissing,
  recordClaimRaceLost,
} from "./lib/claim_support.ts";
import { loadConfig } from "./lib/config.ts";
import {
  addNoticeUnlessUnresolved,
  expireApprovalRequestIfPending,
  getWorkItem,
  type InsertedIssueWorkItem,
  insertIssueWorkItemUnlessActive,
  listActive,
  listExpiredPendingApprovalRequests,
  nextCycleForIssue,
  recordFailure,
  resolveUnresolvedNoticesByPrefix,
  setFlowJobId,
  updateStatusIfCurrent,
  updateStatusIfLeaseHolder,
} from "./lib/db.ts";
import { notifyBestEffort } from "./lib/discord.ts";
import {
  ClaimOwnershipUnknownError,
  claimIssue,
  type GhClient,
  getIssue,
  getLabelerLogin,
  getViewer,
  type IssueSearchItem,
  LabelerCheckLimitError,
  searchIssues,
} from "./lib/github.ts";
import { parseFlowJobId } from "./lib/implement_launch_support.ts";
import { type Logger, logger, maskSecrets } from "./lib/log.ts";
import {
  confirmLabeler,
  decideClosureOnly,
  decideIssueActions,
  decideReconcileAction,
  deployedShaMismatchMessage,
  filterByRepoAllowlist,
  type IssueCandidate,
  type IssueDecision,
  isWaitingForHuman,
  type JobState,
  LABELER_DENIED_KIND,
  labelerDeniedMessage,
  labelerPolicyFor,
  type ReconcileGithubState,
  readJobState,
  recordLabelerCheckLimit,
} from "./lib/poll_support.ts";
import { postSupersededComments } from "./lib/supersede_support.ts";
import type { FactoryConfig, WorkItem } from "./lib/types.ts";
import {
  type CommandRunner,
  ensureFactoryClone,
  listWorktrees,
  pathExists,
  removeWorktree,
  runCommand,
} from "./lib/workspace.ts";
import { describeReason, nextActionFor } from "./steps/pr_workflow_support.ts";

// ---------------------------------------------------------------------------
// self cloneのHEADの取得
// ---------------------------------------------------------------------------

/**
 * self cloneのHEADのshaを返す(`git rev-parse HEAD`)。gitが失敗したら
 * 例外を投げる。`checkDeployedSha`だけが使う。
 * `lib/poll_support.ts`は判断の純粋関数だけを置く場所で、これは他に呼び手の
 * いないgitの入出力なので、このscriptに置く。
 */
export async function readRepoHeadSha(
  run: CommandRunner,
  dir: string,
  home?: string,
  path?: string,
): Promise<string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  const resolvedHome = home ?? process.env.HOME;
  if (resolvedHome !== undefined) env.HOME = resolvedHome;
  const resolvedPath = path ?? process.env.PATH;
  if (resolvedPath !== undefined) env.PATH = resolvedPath;

  const result = await run(
    [
      "git",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "credential.helper=",
      "rev-parse",
      "HEAD",
    ],
    { cwd: dir, env },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      maskSecrets(
        `git rev-parse HEAD failed in ${dir}: ${result.stderr.trim()}`,
      ),
    );
  }
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// 小さな補助関数
// ---------------------------------------------------------------------------

async function recordFailureSafe(
  step: string,
  err: unknown,
  log: Logger,
  workItemId: number | null = null,
): Promise<void> {
  const message = maskSecrets(err instanceof Error ? err.message : String(err));
  log.error(step, { error: message });
  try {
    await recordFailure({
      work_item_id: workItemId,
      flow_path: "f/factory/poll_issues",
      job_id: process.env.WM_JOB_ID ?? "unknown",
      step,
      error: message,
    });
  } catch (recordErr) {
    log.error("failed to record failure", {
      error: maskSecrets(String(recordErr)),
    });
  }
}

/**
 * self cloneのHEADのshaを変数`f/factory/deployed_sha`と比べ、
 * 食い違えばnoticeを記録する。noticeを残すだけでジョブは失敗させない。
 * 同じ版の組の未解決のnoticeがあれば、新しく記録しない(版の組が変われば記録する)。
 * 変数が無い・空のときは、まだ比べる対象が無いとみなす。
 */
async function checkDeployedSha(
  config: FactoryConfig,
  ghToken: string,
  log: Logger,
): Promise<void> {
  try {
    const factoryClone = await ensureFactoryClone({
      run: runCommand,
      repoUrl: config.factory_repo,
      ghToken,
      branch: config.factory_branch,
    });
    const selfSha = await readRepoHeadSha(runCommand, factoryClone.dir);

    let deployedSha: string;
    try {
      deployedSha = await wmill.getVariable("f/factory/deployed_sha");
    } catch {
      return; // 変数がまだ無い。`self_update`が一度も動いていない。
    }
    if (deployedSha.length === 0 || deployedSha === selfSha) return;

    await addNoticeUnlessUnresolved({
      kind: "deployed_sha_mismatch",
      message: deployedShaMismatchMessage(selfSha, deployedSha),
    });
  } catch (err) {
    log.warn("deployed_sha check failed", {
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
  }
}

/**
 * `flowJobId`のジョブの状態を返す(`readJobState`に`JobService.getJob`を渡す)。例外は投げない。
 * 取得の失敗を`unknown`と読み替えたときは、その作業項目のIDと一緒に警告ログに残す。
 */
async function getJobState(
  workItemId: number,
  flowJobId: string | null,
  log: Logger,
): Promise<JobState> {
  return readJobState(
    (id) =>
      wmill.JobService.getJob({
        workspace: process.env.WM_WORKSPACE ?? "",
        id,
        noLogs: true,
        noCode: true,
      }),
    flowJobId,
    (failure) =>
      log.warn("flow job state could not be read", {
        work_item_id: workItemId,
        flow_job_id: flowJobId,
        ...failure,
      }),
  );
}

/**
 * 閉じた・マージされたPRについて、pr_reviewのdetachedなworktree
 * (`/workspaces/<owner>/<repo>/review-<pr>-<sha7>`)を削除する。
 * 失敗はログに残すだけで例外を投げない。
 * pr_fixの`git gtr`のworktreeはPRのブランチ名で決まり、reconcileは
 * ブランチ名を追っていないので、ここでは消さない。
 * `cleanup_workspaces.ts`が保持期間を過ぎたものを掃除する。
 */
async function removePrWorktrees(
  owner: string,
  repo: string,
  prNumber: number,
  log: Logger,
): Promise<void> {
  const repoDir = `/workspaces/${owner}/${repo}/main`;
  if (!(await pathExists(repoDir))) return;
  try {
    const entries = await listWorktrees({ run: runCommand, repoDir });
    const targets = entries.filter((entry) =>
      entry.path.includes(`/review-${prNumber}-`),
    );
    for (const target of targets) {
      try {
        await removeWorktree({
          run: runCommand,
          repoDir,
          dir: target.path,
          force: true,
        });
      } catch (err) {
        log.warn("reconcile: failed to remove pr worktree", {
          path: target.path,
          error: maskSecrets(err instanceof Error ? err.message : String(err)),
        });
      }
    }
  } catch (err) {
    log.warn("reconcile: failed to list worktrees", {
      repoDir,
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
  }
}

// ---------------------------------------------------------------------------
// reconcile(全種別)
// ---------------------------------------------------------------------------

async function reconcileActiveItems(
  client: GhClient,
  active: readonly WorkItem[],
  config: FactoryConfig,
  discordWebhookUrl: string,
  log: Logger,
): Promise<number> {
  let count = 0;
  const now = new Date();
  // 孤立とみなすまでの猶予。ジョブは終わった・無いのに行の更新が遅れている
  // だけなら10分で足りるが、Claude Codeの1回の呼び出しは
  // `claude_timeout_sec`まで続きうる。`getJobState`が長引く実行を
  // 見誤った場合に備え、10分を下限に、タイムアウト2回分の余裕を取る。
  const orphanGraceMs = Math.max(
    10 * 60_000,
    config.claude_timeout_sec * 2 * 1000,
  );

  for (const item of active) {
    const label =
      item.kind === "audit"
        ? `${item.owner}/${item.repo} audit#${String(item.id)}`
        : item.kind === "issue"
          ? `${item.owner}/${item.repo}#${item.issue_number ?? "?"}`
          : `${item.owner}/${item.repo}#${item.pr_number ?? "?"}`;
    try {
      let github: ReconcileGithubState;
      if (item.kind === "audit") {
        // 監査の作業項目には、確かめるGitHubのオブジェクトが無い。
        github = { kind: "audit" };
      } else if (item.kind === "issue") {
        if (item.issue_number === null) continue;
        const issue = await getIssue(
          client,
          item.owner,
          item.repo,
          item.issue_number,
        );
        github = {
          kind: "issue",
          open: issue.state === "open",
        };
      } else {
        if (item.pr_number === null) continue;
        // PRの番号もissues APIで引け、ラベルや状態の形も同じ。
        const asIssue = await getIssue(
          client,
          item.owner,
          item.repo,
          item.pr_number,
        );
        github = { kind: "pr", open: asIssue.state === "open" };
      }

      const decision = isWaitingForHuman(item.status)
        ? decideClosureOnly(github)
        : decideReconcileAction(
            item,
            github,
            await getJobState(item.id, item.flow_job_id, log),
            now,
            orphanGraceMs,
          );
      if (decision.action === "none") continue;

      if (item.flow_job_id !== null) {
        try {
          await wmill.cancelJob(item.flow_job_id, decision.reason);
        } catch {
          // 既に終了・取り消し済みなら、することは無い。
        }
      }

      const targetStatus =
        decision.action === "cancel" ? "cancelled" : "failed";
      const note = `reconcile: ${decision.reason}`;
      // 読み取った後にflow_job_idが変わっていれば(実装フローがリースを取った、新しいフローが
      // 起動されたなど)その実行を止めないよう、観測した値のままのときだけ状態を変える。
      // 更新できなかったときは、並行する処理が先に状態を進めている。
      const updated = await updateStatusIfLeaseHolder(
        item.id,
        item.status,
        targetStatus,
        item.flow_job_id,
        note,
      );
      if (!updated) continue;

      // Issueの`factory`も、PRの`factory:review`・`factory:fix`も、トリガー
      // ラベルは取得時に消費済みなので、ここで外すラベルは無い。状態は
      // `work_items.status`にだけあり、PRは状態ラベルではなくDBから
      // (`poll_prs.ts`の`listTrackedPrs`で)見つけ直す。

      if (
        item.kind !== "issue" &&
        decision.action === "cancel" &&
        decision.reason === "pr_closed" &&
        item.pr_number !== null
      ) {
        await removePrWorktrees(item.owner, item.repo, item.pr_number, log);
      }

      await notifyBestEffort(
        discordWebhookUrl,
        {
          kind: "job_failed",
          instance_name: config.instance_name,
          flow_path: "f/factory/poll_issues",
          job_id: item.flow_job_id ?? "unknown",
          error: `${label}: ${note}`,
        },
        log,
      );

      count += 1;
    } catch (err) {
      await recordFailureSafe(`reconcile:${label}`, err, log, item.id);
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// 新しいIssueの取得
// ---------------------------------------------------------------------------

/**
 * 見つかったIssueを、着手の判定にかける候補にする。
 * 付与者はトリガーラベルの最後の`labeled`イベントから取る。
 * イベントを取得できないIssueは候補に加えず、`recordFailure`に渡す。
 * 付与者を確かめられないまま着手しないためで、次のポーリングで取得し直す。
 * 付与者を判定できないIssue(直近のラベルのイベントにトリガーラベルが無い)も候補に加えず、
 * `recordCheckLimit`でnoticeに残す。記録に失敗しても、警告のログだけにして次のIssueへ進む。
 */
export async function buildIssueCandidates(
  client: GhClient,
  found: readonly IssueSearchItem[],
  activeIssueKeys: ReadonlySet<string>,
  triggerLabel: string,
  handlers: {
    readonly recordFailure: (step: string, err: unknown) => Promise<void>;
    readonly recordCheckLimit: (
      item: IssueSearchItem,
      label: string,
    ) => Promise<void>;
    readonly log: Logger;
  },
): Promise<IssueCandidate[]> {
  const candidates: IssueCandidate[] = [];
  for (const item of found) {
    try {
      const labelerLogin = await getLabelerLogin(
        client,
        item.owner,
        item.repo,
        item.number,
        triggerLabel,
      );
      candidates.push({
        owner: item.owner,
        repo: item.repo,
        number: item.number,
        title: item.title,
        body: item.body,
        htmlUrl: item.htmlUrl,
        labelerLogin,
        hasActiveWorkItem: activeIssueKeys.has(
          `${item.owner}/${item.repo}#${item.number}`,
        ),
      });
    } catch (err) {
      if (err instanceof LabelerCheckLimitError) {
        // 判定できない対象は、失敗ではなく人の操作を求めるnoticeにする。
        try {
          await handlers.recordCheckLimit(item, err.label);
        } catch (recordErr) {
          handlers.log.warn(
            "labeler_check_limit notice could not be recorded",
            {
              target: `${item.owner}/${item.repo}#${String(item.number)}`,
              error: maskSecrets(
                recordErr instanceof Error
                  ? recordErr.message
                  : String(recordErr),
              ),
            },
          );
        }
        continue;
      }
      await handlers.recordFailure(
        `fetch_labeler:${item.owner}/${item.repo}#${item.number}`,
        err,
      );
    }
  }
  return candidates;
}

/**
 * Issueを取得した後に、作業項目を登録できなかったときの`reason`。
 * `describeReason`と`nextActionFor`が通知の文にする。
 */
const REGISTER_FAILED_REASON = "claimed issue could not be registered";

export type RegisterClaimedIssueDeps = {
  readonly nextCycleForIssue: typeof nextCycleForIssue;
  readonly insertWorkItem: typeof insertIssueWorkItemUnlessActive;
  readonly addNoticeUnlessUnresolved: typeof addNoticeUnlessUnresolved;
  readonly notifyBestEffort: typeof notifyBestEffort;
};

const defaultRegisterDeps: RegisterClaimedIssueDeps = {
  nextCycleForIssue,
  insertWorkItem: insertIssueWorkItemUnlessActive,
  addNoticeUnlessUnresolved,
  notifyBestEffort,
};

/**
 * 取得したIssueの作業項目を登録し、そのIDと、直後の文で取り消した`approved`の作業項目を返す。
 * 同じIssueの稼働中の作業項目が既にあって挿入されなかったときは、`null`を返す。
 * 並行する取得に先を越された場合で、そちらが作業を受け持つので、
 * `claim_race_lost`のnoticeを残すだけで、人には知らせない。
 * 登録に失敗したときは、人の対応待ちの通知(Issueへのリンクと次の操作つき)を
 * 送ってから、元の例外をそのまま投げる。呼び出し元が`job_failures`に記録する。
 * 取得の時点でトリガーラベルは外れていて、作業項目も無いので、
 * このIssueを次のポーリングは拾わない。通知が無いと、人は失敗タブを
 * 見に行かない限り気づけず、失敗タブには再実行できる作業項目も無い。
 * 取得を自動で戻さないのは、次の2つの害があるためである。
 * Factory自身のPATがラベルを付け直すと、直近のラベル付与者がFactoryになり、
 * 付与者の確認が人ではなくFactoryに対して行われる。
 * また、DBの障害が続く間は、取得と失敗をポーリングのたびに繰り返す。
 * 通知はベストエフォートで、失敗しても元の例外を隠さない。
 */
export async function registerClaimedIssue(
  input: {
    readonly candidate: IssueCandidate;
    readonly viewerLogin: string;
    readonly instanceName: string;
    readonly discordWebhookUrl: string;
    readonly log: Logger;
  },
  deps: RegisterClaimedIssueDeps = defaultRegisterDeps,
): Promise<InsertedIssueWorkItem | null> {
  const { candidate } = input;
  let registered: InsertedIssueWorkItem | null;
  try {
    const cycle = await deps.nextCycleForIssue(
      candidate.owner,
      candidate.repo,
      candidate.number,
    );
    registered = await deps.insertWorkItem({
      cycle,
      source: "issue",
      kind: "issue",
      owner: candidate.owner,
      repo: candidate.repo,
      issue_number: candidate.number,
      issue_url: candidate.htmlUrl,
      pr_number: null,
      title: candidate.title,
      body: candidate.body,
      status: "picked",
      attempt: 1,
      claimed_by: input.viewerLogin,
      flow_job_id: null,
      resume_url: null,
      cancel_url: null,
      head_sha: null,
      parent_work_item_id: null,
    });
  } catch (err) {
    await deps.notifyBestEffort(
      input.discordWebhookUrl,
      {
        kind: "needs_human",
        instance_name: input.instanceName,
        owner: candidate.owner,
        repo: candidate.repo,
        url: candidate.htmlUrl,
        reason: describeReason(REGISTER_FAILED_REASON),
        target: { kind: "issue", number: candidate.number },
        next_action: nextActionFor(REGISTER_FAILED_REASON),
      },
      input.log,
    );
    throw err;
  }
  if (registered === null) {
    await recordClaimRaceLost(
      `${candidate.owner}/${candidate.repo}#${String(candidate.number)}`,
      ACTIVE_WORK_ITEM_EXISTS_REASON,
      deps.addNoticeUnlessUnresolved,
      input.log,
    );
  }
  return registered;
}

/**
 * 取得でトリガーラベルを外した結果を、所有したか判断できなかったときの`reason`。
 * `describeReason`と`nextActionFor`が通知の文にする。
 */
const CLAIM_OWNERSHIP_UNKNOWN_REASON =
  "claim ownership could not be determined";

export type ClaimNoticeDeps = {
  readonly claimIssue: typeof claimIssue;
  readonly addNoticeUnlessUnresolved: typeof addNoticeUnlessUnresolved;
  readonly resolveUnresolvedNoticesByPrefix: typeof resolveUnresolvedNoticesByPrefix;
};

const defaultClaimNoticeDeps: ClaimNoticeDeps = {
  claimIssue,
  addNoticeUnlessUnresolved,
  resolveUnresolvedNoticesByPrefix,
};

/** `poll_issues`がnoticeを解決済みにしたときに、`resolved_by`へ記録する名前。 */
export const POLL_ISSUES_RESOLVER = "poll_issues";

/**
 * 付与者の確認で見送ったIssueのnoticeの本文の先頭を返す。
 * 記録(`recordLabelerDenied`)と解決(`claimIssueWithNotice`)が同じ関数から作り、
 * 両者がずれて解決できなくなるのを防ぐ。
 * 末尾の`: `までを含めるので、`#1`の接頭辞は`#12`のnoticeに当たらない。
 */
export function labelerDeniedMessagePrefix(
  candidate: Pick<IssueCandidate, "owner" | "repo" | "number">,
): string {
  return `${candidate.owner}/${candidate.repo}#${String(candidate.number)}: `;
}

/**
 * 取得できたIssueの、見送りのnoticeを解決済みにする。
 * 許可された人がラベルを付け直して取得できたので、見送りの記録はもう対応を要しない。
 * 解決に失敗しても、取得は成否を変えない(ラベルは既に外れている)。警告をログに残すだけにする。
 */
async function resolveLabelerDenied(
  candidate: IssueCandidate,
  resolve: typeof resolveUnresolvedNoticesByPrefix,
  log: Logger,
): Promise<void> {
  try {
    await resolve(
      LABELER_DENIED_KIND,
      labelerDeniedMessagePrefix(candidate),
      POLL_ISSUES_RESOLVER,
    );
  } catch (err) {
    log.warn("labeler_denied notices could not be resolved", {
      target: `${candidate.owner}/${candidate.repo}#${String(candidate.number)}`,
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
  }
}

/**
 * Issueを取得し、作業を始めてよいか(取得できたか)を返す。
 * 取得の所有は、自分のラベルの削除が成功したことで決まる(`claimIssue`を参照)。
 * - 取得できたときは、assigneeが付いていなくても作業を続ける。
 *   付いていないときだけ、確認の手がかりを`claim_assignee_missing`のnoticeに残す。
 *   このnoticeの記録は、失敗しても取得を妨げない。ラベルは既に外れているので、
 *   ここで例外にすると、ラベルも作業項目も無いIssueが残る。
 * - 取得できたときは、そのIssueの`labeler_denied`のnoticeを解決済みにする。
 *   許可された人がラベルを付け直した結果なので、見送りの記録は残さない。
 *   解決の失敗は取得を妨げず、警告をログに残す。
 * - ほかが先にラベルを外したときは、`claim_race_lost`のnoticeを残して引く。
 * - ラベルの削除が失敗してラベルが残っているときは、次のポーリングが拾い直すので、
 *   通知もnoticeもなく引く。
 * - 所有したか判断できなかったときは、`ClaimOwnershipUnknownError`をそのまま投げる。
 *   呼び出し元が`job_failures`に記録し、該当したIssueをまとめて
 *   `notifyClaimOwnershipUnknown`で人へ知らせる。
 * noticeは同じ本文の未解決のものがあれば追加しない。ラベルが残る間、ポーリングのたびに
 * 積み上がるのを防ぐためで、本文には対象と理由だけを載せ、時刻などの揺れる値を入れない。
 */
export async function claimIssueWithNotice(
  input: {
    readonly client: GhClient;
    readonly candidate: IssueCandidate;
    readonly viewerLogin: string;
    readonly triggerLabel: string;
    readonly log: Logger;
  },
  deps: ClaimNoticeDeps = defaultClaimNoticeDeps,
): Promise<boolean> {
  const { candidate, log } = input;
  const target = `${candidate.owner}/${candidate.repo}#${candidate.number}`;

  const claimResult = await deps.claimIssue(
    input.client,
    candidate.owner,
    candidate.repo,
    candidate.number,
    { triggerLabel: input.triggerLabel, assignee: input.viewerLogin, log },
  );

  if (claimResult.claimed) {
    if (claimResult.assignee === "missing") {
      await recordAssigneeMissing(
        target,
        input.viewerLogin,
        deps.addNoticeUnlessUnresolved,
        log,
      );
    } else if (claimResult.assignee === "unknown") {
      log.warn("claim assignee could not be confirmed", { target });
    }
    await resolveLabelerDenied(
      candidate,
      deps.resolveUnresolvedNoticesByPrefix,
      log,
    );
    return true;
  }

  if (claimResult.outcome === "lost") {
    await recordClaimRaceLost(
      target,
      claimResult.reason,
      deps.addNoticeUnlessUnresolved,
      log,
    );
  }
  return false;
}

export type ClaimUnknownNotifyDeps = {
  readonly notifyBestEffort: typeof notifyBestEffort;
};

const defaultClaimUnknownNotifyDeps: ClaimUnknownNotifyDeps = {
  notifyBestEffort,
};

/** 所有を判断できなかったIssueの通知に、リンクを並べる最大の件数。 */
const CLAIM_UNKNOWN_LIST_LIMIT = 10;

/**
 * 複数のIssueが該当したときの、次の操作。個別の文は「このIssue」と書くため使えない。
 * 個別の文(`nextActionFor`)は理由の規則の表が持ち、ラベル名を引数に取れないので、
 * 既定の`factory`と書いてある。ラベル名を変えている場合は、こちらだけが設定に合う。
 */
function claimUnknownListNextAction(triggerLabel: string): string {
  return `一覧のIssueそれぞれについて、Consoleの作業項目で作業が始まっているか確かめてください。始まっていなければ、そのIssueに\`${triggerLabel}\`ラベルを付け直してください`;
}

/**
 * 1回のポーリングで、取得の所有を判断できなかったIssueを、人の対応待ちとして1件の通知で知らせる。
 * ラベルが外れ、作業項目も無いので、通知が無いと人は気づけない。
 * 障害の間は多くのIssueが同時に該当しうるため、Issueごとに送らず、リンクを並べた1件にまとめる。
 * 並べるのは先頭から`CLAIM_UNKNOWN_LIST_LIMIT`件までで、残りは件数で示す。
 * 各行は`owner/repo#番号 URL`で、複数のリポジトリにまたがっても対象が分かる。
 * タイトルと`url`には、先頭のIssueを載せる。
 * 該当が無ければ何も送らない。通知はベストエフォートである。
 */
export async function notifyClaimOwnershipUnknown(
  input: {
    readonly candidates: readonly IssueCandidate[];
    readonly triggerLabel: string;
    readonly instanceName: string;
    readonly discordWebhookUrl: string;
    readonly log: Logger;
  },
  deps: ClaimUnknownNotifyDeps = defaultClaimUnknownNotifyDeps,
): Promise<void> {
  const first = input.candidates[0];
  if (first === undefined) return;

  const single = describeReason(CLAIM_OWNERSHIP_UNKNOWN_REASON);
  const many = input.candidates.length > 1;
  const listed = input.candidates
    .slice(0, CLAIM_UNKNOWN_LIST_LIMIT)
    .map(
      (candidate) =>
        `- ${candidate.owner}/${candidate.repo}#${String(candidate.number)} ${candidate.htmlUrl}`,
    );
  const rest = input.candidates.length - listed.length;
  const reason = many
    ? [
        `${single}(${String(input.candidates.length)}件)`,
        ...listed,
        ...(rest > 0 ? [`ほか${String(rest)}件`] : []),
      ].join("\n")
    : single;

  await deps.notifyBestEffort(
    input.discordWebhookUrl,
    {
      kind: "needs_human",
      instance_name: input.instanceName,
      owner: first.owner,
      repo: first.repo,
      url: first.htmlUrl,
      reason,
      target: { kind: "issue", number: first.number },
      next_action: many
        ? claimUnknownListNextAction(input.triggerLabel)
        : nextActionFor(CLAIM_OWNERSHIP_UNKNOWN_REASON),
    },
    input.log,
  );
}

export type LabelerDeniedDeps = {
  readonly addNoticeUnlessUnresolved: typeof addNoticeUnlessUnresolved;
};

const defaultLabelerDeniedDeps: LabelerDeniedDeps = {
  addNoticeUnlessUnresolved,
};

/**
 * 付与者の確認で見送ったIssueのnoticeを残す。
 * 見送りではラベルを外さないので、ラベルが付いている間はポーリングのたびに
 * 同じ状況になる。本文は対象とラベルだけで決まり、時刻などの揺れる値を含まないため、
 * 同じ本文の未解決のnoticeがあれば登録しない。
 */
export async function recordLabelerDenied(
  candidate: IssueCandidate,
  triggerLabel: string,
  deps: LabelerDeniedDeps = defaultLabelerDeniedDeps,
): Promise<void> {
  await deps.addNoticeUnlessUnresolved({
    kind: LABELER_DENIED_KIND,
    message: labelerDeniedMessage(candidate, triggerLabel),
  });
}

export type DecisionHandlers = {
  /**
   * 取得の直前に、ラベルの付与者がまだ許可された人かを確かめ直す。
   * 判定の後にラベルが付け直されていることがあるためである。
   * 取得できなかったときは例外を投げ、取得に進まない。
   */
  readonly confirmLabeler: (candidate: IssueCandidate) => Promise<boolean>;
  readonly claim: (candidate: IssueCandidate) => Promise<"claimed" | "skipped">;
  readonly recordDenied: (candidate: IssueCandidate) => Promise<void>;
  readonly recordFailure: (step: string, err: unknown) => Promise<void>;
  readonly notifyOwnershipUnknown: (
    candidates: readonly IssueCandidate[],
  ) => Promise<void>;
};

/**
 * 判定した各Issueを順に処理し、結果の件数を返す。
 * 1件の失敗は`recordFailure`に渡して次へ進む。付与者の確認で見送るIssueのnotice記録も、
 * 同じ扱いにする。
 * 所有を判断できなかったIssueは集め、ループを抜けるときに必ず1回だけ
 * `notifyOwnershipUnknown`へ渡す。`recordFailure`などが想定外に例外を投げて
 * ループが途中で終わっても、集めた分は通知される。
 * ループの例外は通知の後に投げ直す。通知も例外を投げたときは、原因であるループの例外を残し、
 * 通知の失敗は`log`に記録する。ループが成功していれば、通知の例外をそのまま投げる。
 */
export async function processIssueDecisions(
  decisions: readonly IssueDecision[],
  handlers: DecisionHandlers,
  log?: Logger,
): Promise<{ claimed: number; skipped: number; failed: number }> {
  let claimed = 0;
  let skipped = 0;
  let failed = 0;
  const ownershipUnknown: IssueCandidate[] = [];
  // 付与者が許可されていないIssueをnoticeに残し、見送りとして数える。
  const countDenied = async (
    candidate: IssueCandidate,
    where: string,
  ): Promise<void> => {
    try {
      await handlers.recordDenied(candidate);
      skipped += 1;
    } catch (err) {
      failed += 1;
      await handlers.recordFailure(`labeler_denied:${where}`, err);
    }
  };
  let loopFailure: { readonly error: unknown } | null = null;
  try {
    for (const decision of decisions) {
      const { candidate } = decision;
      const where = `${candidate.owner}/${candidate.repo}#${String(candidate.number)}`;
      if (decision.action === "skip_active") {
        skipped += 1;
        continue;
      }
      if (decision.action === "skip_labeler") {
        await countDenied(candidate, where);
        continue;
      }
      // 取得の直前の確認は、取得の前の失敗として別に記録する。
      // この時点でラベルは外れておらず、次のポーリングが拾い直す。
      let confirmed: boolean;
      try {
        confirmed = await handlers.confirmLabeler(candidate);
      } catch (err) {
        failed += 1;
        await handlers.recordFailure(`confirm_labeler:${where}`, err);
        continue;
      }
      if (!confirmed) {
        await countDenied(candidate, where);
        continue;
      }
      try {
        const outcome = await handlers.claim(candidate);
        if (outcome === "claimed") claimed += 1;
        else skipped += 1;
      } catch (err) {
        failed += 1;
        if (err instanceof ClaimOwnershipUnknownError) {
          ownershipUnknown.push(candidate);
        }
        await handlers.recordFailure(`claim_issue:${where}`, err);
      }
    }
  } catch (err) {
    loopFailure = { error: err };
  }
  try {
    await handlers.notifyOwnershipUnknown(ownershipUnknown);
  } catch (notifyErr) {
    if (loopFailure === null) throw notifyErr;
    log?.error("failed to notify claims with unknown ownership", {
      error: maskSecrets(
        notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
      ),
    });
  }
  if (loopFailure !== null) throw loopFailure.error;
  return { claimed, skipped, failed };
}

async function claimAndStart(
  client: GhClient,
  candidate: IssueCandidate,
  viewerLogin: string,
  config: FactoryConfig,
  discordWebhookUrl: string,
  log: Logger,
): Promise<"claimed" | "skipped"> {
  const claimed = await claimIssueWithNotice({
    client,
    candidate,
    viewerLogin,
    triggerLabel: config.trigger_label,
    log,
  });
  if (!claimed) return "skipped";

  const registered = await registerClaimedIssue({
    candidate,
    viewerLogin,
    instanceName: config.instance_name,
    discordWebhookUrl,
    log,
  });
  if (registered === null) return "skipped";
  const workItemId = registered.id;

  await notifyBestEffort(
    discordWebhookUrl,
    {
      kind: "issue_claimed",
      instance_name: config.instance_name,
      owner: candidate.owner,
      repo: candidate.repo,
      issue_number: candidate.number,
      issue_url: candidate.htmlUrl,
      title: candidate.title,
    },
    log,
  );

  try {
    // 応答がジョブIDでなければ例外にし、`main`が起動の失敗と同じく`job_failures`に記録する。
    const flowJobId = parseFlowJobId(
      await wmill.runFlowAsync("f/factory/pipeline", {
        work_item_id: workItemId,
        attempt: 1,
      }),
      "runFlowAsync",
    );
    await setFlowJobId(workItemId, flowJobId);
  } finally {
    // 古い承認済みの項目は、挿入の直後に取り消されている。GitHubへの投稿の待ちが、
    // 作業項目が作られてからジョブIDが記録されるまでの間を延ばさないよう、起動の後に投稿する。
    // 起動に失敗しても取り消しは済んでいるので、コメントは投稿する。投稿は例外を投げない。
    await postSupersededComments({
      client,
      owner: candidate.owner,
      repo: candidate.repo,
      issueNumber: candidate.number,
      viewerLogin,
      newWorkItemId: workItemId,
      superseded: registered.superseded,
      log,
    });
  }

  return "claimed";
}

// ---------------------------------------------------------------------------
// 保留中の"requirements"承認依頼の期限切れ処理。承認依頼の記録は何も待たない
// ので、期限を過ぎた依頼を期限切れにするのはここだけである。
// "issue_proposal"の依頼は`expires_at`を持たない(`pr_fix_finish.ts`の
// `insertApprovalRequest`の呼び出しを参照)ので、そもそも
// `listExpiredPendingApprovalRequests`の結果に現れない。それでも
// 下の分岐のために`expiredRequirementsRequests`で型を絞る。
// ---------------------------------------------------------------------------

async function expirePendingApprovals(
  config: FactoryConfig,
  discordWebhookUrl: string,
  log: Logger,
): Promise<number> {
  let count = 0;
  const expired = await listExpiredPendingApprovalRequests(new Date());
  const requirementsExpired = expiredRequirementsRequests(expired);

  for (const request of requirementsExpired) {
    try {
      const wasExpired = await expireApprovalRequestIfPending(request.id);
      if (!wasExpired) continue; // 並行する決定か期限切れ処理が先に処理した。

      const workItem = await getWorkItem(request.work_item_id);
      if (workItem === null || workItem.issue_number === null) continue;

      const updated = await updateStatusIfCurrent(
        workItem.id,
        "awaiting_approval",
        "expired",
        "approval timed out",
      );
      if (!updated) continue; // 作業項目は既に次の状態に進んでいる。

      await notifyBestEffort(
        discordWebhookUrl,
        {
          kind: "needs_human",
          instance_name: config.instance_name,
          owner: workItem.owner,
          repo: workItem.repo,
          url: workItem.issue_url ?? "",
          reason: describeReason("approval timed out"),
          target: { kind: "issue", number: workItem.issue_number },
          next_action: nextActionFor("approval timed out"),
        },
        log,
      );

      count += 1;
    } catch (err) {
      await recordFailureSafe(
        `expire_approval:${String(request.id)}`,
        err,
        log,
        request.work_item_id,
      );
    }
  }

  return count;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(): Promise<{
  claimed: number;
  skipped: number;
  reconciled: number;
  expired: number;
  failed: number;
}> {
  const log = logger("poll_issues");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const discordWebhookUrl = await wmill.getVariable(
    "f/factory/discord_webhook_url",
  );
  const client: GhClient = { run: runCommand, ghToken };

  // ヘルスチェック。PATが壊れている・期限切れのとき、下のIssueを
  // 黙ってすべて飛ばすのではなく、ジョブ全体を失敗させて
  // `on_error_schedule`で知らせる。
  const viewer = await getViewer(client);
  log.info("health check ok", { login: viewer.login });

  await checkDeployedSha(config, ghToken, log);

  let claimed = 0;
  let skipped = 0;
  let failed = 0;

  const active = await listActive();
  const activeIssueKeys = new Set(
    active
      .filter((item) => item.kind === "issue" && item.issue_number !== null)
      .map((item) => `${item.owner}/${item.repo}#${item.issue_number}`),
  );

  const rawCandidates: IssueSearchItem[] = [];
  for (const owner of config.owners) {
    try {
      const found = await searchIssues(client, {
        owner: owner.name,
        ownerKind: owner.kind,
        label: config.trigger_label,
      });
      rawCandidates.push(...found);
    } catch (err) {
      failed += 1;
      await recordFailureSafe(`search_issues:${owner.name}`, err, log);
    }
  }

  const allowed = filterByRepoAllowlist(rawCandidates, config);
  const candidates = await buildIssueCandidates(
    client,
    allowed,
    activeIssueKeys,
    config.trigger_label,
    {
      log,
      recordFailure: (step, err) => recordFailureSafe(step, err, log),
      recordCheckLimit: (item, label) =>
        recordLabelerCheckLimit(addNoticeUnlessUnresolved, item, label),
    },
  );
  const labelerPolicy = labelerPolicyFor(viewer.login, config);
  const decisions = decideIssueActions(candidates, labelerPolicy);

  // 所有を判断できなかったIssueの通知は、`processIssueDecisions`がループを抜けるときに送る。
  const processed = await processIssueDecisions(
    decisions,
    {
      confirmLabeler: (candidate) =>
        confirmLabeler(client, candidate, config.trigger_label, labelerPolicy),
      claim: (candidate) =>
        claimAndStart(
          client,
          candidate,
          viewer.login,
          config,
          discordWebhookUrl,
          log,
        ),
      recordDenied: (candidate) =>
        recordLabelerDenied(candidate, config.trigger_label),
      recordFailure: (step, err) => recordFailureSafe(step, err, log),
      notifyOwnershipUnknown: (unknown) =>
        notifyClaimOwnershipUnknown({
          candidates: unknown,
          triggerLabel: config.trigger_label,
          instanceName: config.instance_name,
          discordWebhookUrl,
          log,
        }),
    },
    log,
  );
  claimed += processed.claimed;
  skipped += processed.skipped;
  failed += processed.failed;

  const reconciled = await reconcileActiveItems(
    client,
    active,
    config,
    discordWebhookUrl,
    log,
  );

  const expired = await expirePendingApprovals(config, discordWebhookUrl, log);

  return { claimed, skipped, reconciled, expired, failed };
}
