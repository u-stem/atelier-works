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
import { loadConfig } from "./lib/config.ts";
import {
  addNotice,
  expireApprovalRequestIfPending,
  getWorkItem,
  insertWorkItem,
  listActive,
  listExpiredPendingApprovalRequests,
  nextCycleForIssue,
  recordFailure,
  setFlowJobId,
  updateStatusIfCurrent,
} from "./lib/db.ts";
import { type NotifyEvent, notify } from "./lib/discord.ts";
import {
  claimIssue,
  type GhClient,
  getIssue,
  getIssueTimeline,
  getViewer,
  type IssueSearchItem,
  searchIssues,
} from "./lib/github.ts";
import { type Logger, logger, maskSecrets } from "./lib/log.ts";
import {
  associationFromLabeledEvent,
  decideClosureOnly,
  decideIssueActions,
  decideReconcileAction,
  filterByRepoAllowlist,
  type IssueCandidate,
  isWaitingForHuman,
  type JobState,
  type ReconcileGithubState,
} from "./lib/poll_support.ts";
import {
  type FactoryConfig,
  isBoolean,
  isRecord,
  type WorkItem,
} from "./lib/types.ts";
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

async function notifySafe(
  webhookUrl: string,
  event: NotifyEvent,
  log: Logger,
): Promise<void> {
  if (webhookUrl.length === 0) return;
  try {
    await notify(webhookUrl, event);
  } catch (err) {
    log.warn("discord notify failed", { error: maskSecrets(String(err)) });
  }
}

/**
 * self cloneのHEADのshaを変数`f/factory/deployed_sha`と比べ、
 * 食い違えばnoticeを記録する。noticeを残すだけでジョブは失敗させない。
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

    await addNotice({
      kind: "deployed_sha_mismatch",
      message: `self clone の HEAD(${selfSha})が f/factory/deployed_sha(${deployedSha})と一致しません`,
    });
  } catch (err) {
    log.warn("deployed_sha check failed", {
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
  }
}

/**
 * `JobService.getJob`の応答の`type`を`JobState`に読み替える。
 * 取得できなかったときは`job`が`null`か非レコードになり、`absent`を返す
 * (`getJobState`は404も他のエラーも`null`にまとめて渡すので、
 * 判断はこの関数だけで完結し、単体テストできる)。
 * 取得できたが形が分からない(`type`が無い、未知の値)ときは、`absent`ではなく
 * `running`を返す。完了を確かめられないことを理由に作業項目を取り消したり
 * 孤立扱いしたりしないためで、`absent`にするのは取得そのものが失敗したときだけ。
 *
 * ジョブの状態を`wmill.getResultMaybe`ではなく`JobService.getJob`で読む理由:
 * `getResultMaybe`は、`wmill job get`で`running`と確かめた直後のジョブにも
 * `completed: true`を返したことがある。そのままでは、Claude Codeを呼んでいる
 * 最中の`pipeline`が猶予の経過後に`absent`・`completed`に見え、
 * 実行中に取り消された。`getJob`はジョブの行を直接読み、結果を待つ動作が無い。
 *
 * `CompletedJob`の`success`と`canceled`は、取り消し・失敗を確かめられた
 * ジョブについて`decideReconcileAction`が孤立の猶予を飛ばすのに使う。
 * どちらかが真偽値でない(本来は起きない)ときは`success: true`・
 * `canceled: false`とし、猶予を守る経路に倒す。あいまいな信号では
 * 動かないという、`type`が無い場合と同じ方針である。
 */
export function jobStateFromJob(job: unknown): JobState {
  if (!isRecord(job)) return { state: "absent" };
  if (job.type === "CompletedJob") {
    return {
      state: "completed",
      success: isBoolean(job.success) ? job.success : true,
      canceled: isBoolean(job.canceled) ? job.canceled : false,
    };
  }
  return { state: "running" };
}

async function getJobState(flowJobId: string | null): Promise<JobState> {
  if (flowJobId === null) return { state: "absent" };
  let job: unknown = null;
  try {
    job = await wmill.JobService.getJob({
      workspace: process.env.WM_WORKSPACE ?? "",
      id: flowJobId,
      noLogs: true,
      noCode: true,
    });
  } catch {
    job = null;
  }
  return jobStateFromJob(job);
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
            await getJobState(item.flow_job_id),
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
      const updated = await updateStatusIfCurrent(
        item.id,
        item.status,
        targetStatus,
        note,
      );
      if (!updated) continue; // 並行する処理が先に状態を進めた。

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

      await notifySafe(
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

async function buildIssueCandidates(
  client: GhClient,
  found: readonly IssueSearchItem[],
  activeIssueKeys: ReadonlySet<string>,
  log: Logger,
): Promise<IssueCandidate[]> {
  const candidates: IssueCandidate[] = [];
  for (const item of found) {
    try {
      const timelineEvent = await getIssueTimeline(
        client,
        item.owner,
        item.repo,
        item.number,
      );
      candidates.push({
        owner: item.owner,
        repo: item.repo,
        number: item.number,
        title: item.title,
        body: item.body,
        htmlUrl: item.htmlUrl,
        labelerAssociation: associationFromLabeledEvent(timelineEvent),
        hasActiveWorkItem: activeIssueKeys.has(
          `${item.owner}/${item.repo}#${item.number}`,
        ),
      });
    } catch (err) {
      await recordFailureSafe(
        `fetch_timeline:${item.owner}/${item.repo}#${item.number}`,
        err,
        log,
      );
    }
  }
  return candidates;
}

async function claimAndStart(
  client: GhClient,
  candidate: IssueCandidate,
  viewerLogin: string,
  config: FactoryConfig,
  discordWebhookUrl: string,
  log: Logger,
): Promise<"claimed" | "skipped"> {
  const claimResult = await claimIssue(
    client,
    candidate.owner,
    candidate.repo,
    candidate.number,
    { triggerLabel: config.trigger_label, assignee: viewerLogin },
  );
  if (!claimResult.claimed) {
    await addNotice({
      kind: "claim_race_lost",
      message: `${candidate.owner}/${candidate.repo}#${candidate.number}: ${claimResult.reason}`,
    });
    return "skipped";
  }

  const cycle = await nextCycleForIssue(
    candidate.owner,
    candidate.repo,
    candidate.number,
  );
  const workItemId = await insertWorkItem({
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
    claimed_by: viewerLogin,
    flow_job_id: null,
    resume_url: null,
    cancel_url: null,
    head_sha: null,
    parent_work_item_id: null,
  });

  await notifySafe(
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

  const flowJobId = await wmill.runFlowAsync("f/factory/pipeline", {
    work_item_id: workItemId,
    attempt: 1,
  });
  await setFlowJobId(workItemId, flowJobId);

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

      await notifySafe(
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
    log,
  );
  const decisions = decideIssueActions(
    candidates,
    config.allowed_labeler_associations,
  );

  for (const decision of decisions) {
    const { candidate } = decision;
    if (decision.action === "skip_active") {
      skipped += 1;
      continue;
    }
    if (decision.action === "skip_association") {
      skipped += 1;
      await addNotice({
        kind: "labeler_association_denied",
        message: `${candidate.owner}/${candidate.repo}#${candidate.number}: 直近のラベル付与者の association "${decision.association ?? "unknown"}" は allowed_labeler_associations に含まれていません`,
      });
      continue;
    }
    try {
      const outcome = await claimAndStart(
        client,
        candidate,
        viewer.login,
        config,
        discordWebhookUrl,
        log,
      );
      if (outcome === "claimed") claimed += 1;
      else skipped += 1;
    } catch (err) {
      failed += 1;
      await recordFailureSafe(
        `claim_issue:${candidate.owner}/${candidate.repo}#${candidate.number}`,
        err,
        log,
      );
    }
  }

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
