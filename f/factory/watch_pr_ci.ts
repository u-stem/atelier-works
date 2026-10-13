// 5分ごとに、Factoryが作ったPRのCI(GitHub Actionsのpull_requestとpushの実行)を、
// headのコミット単位で判定する。失敗したheadは要対応のnoticeとDiscordで知らせ、
// 同じPRのheadが通ったら、失敗のnoticeを自動で解決する。閉じたPRの行は整理する。
// 観測と通知だけで、PRにもリポジトリにも書き込まない。Claudeにログは渡さない。
// 失敗を直す作業項目が終わった`fixing`の行は、回復で`failed`か`superseded`に戻す。
// 回復は設定`pr_ci_watch_enabled`に依らず動く。作業項目の起動はしない。
//
// 流れと判断は`./lib/pr_ci_watch.ts`にあり、このファイルは入出力をつなぐだけ。
// 対象は、作業項目の`pr_url`から引いたPRのうち、許可リスト(`repo_allowlist`と照合済みの`owners`、
// 常に対象の`factory_repo`)に合うリポジトリのものである。
// GITHUB_TOKENにActionsの読み取り権限が無いリポジトリは、`pr_ci_check_denied`のnoticeで知らせる。
// 設定`pr_ci_watch_enabled`が`false`のときは、回復だけを行い、発見と判定と通知はしない。
// 回復の対象の行が無ければ、何も読まずに終わる。

// デプロイ先のサーバーの版に合わせて1.817.0に固定する。
import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "./lib/config.ts";
import {
  addNoticeUnlessUnresolved,
  findOrphanFixingPrCiChecks,
  getWorkItem,
  latestFixRound,
  latestStatusEvent,
  listFailedPrCiChecks,
  listFixingPrCiChecks,
  listNoCiPrCiChecksToRecheck,
  listPendingPrCiChecks,
  listPrCiChecksForPr,
  listPrOpenIssueWorkItems,
  markPrCiNotified,
  recordFailure,
  recordPrCiCheck,
  releaseFixingPrCiCheck,
  resolveUnresolvedNoticesByPrefix,
  touchPrCiCheck,
  transitionPrCiCheck,
} from "./lib/db.ts";
import { notifyBestEffort } from "./lib/discord.ts";
import {
  type GhClient,
  getAccountId,
  getPr,
  listPrHeadWorkflowRuns,
} from "./lib/github.ts";
import { type Logger, logger, maskSecrets } from "./lib/log.ts";
import { filterVerifiedOwners } from "./lib/poll_support.ts";
import { readFixItemState } from "./lib/pr_ci_fix_recovery.ts";
import {
  buildRepoGates,
  PR_CI_WATCH_IDLE_RESULT,
  type PrCiWatchDeps,
  type PrCiWatchResult,
  runPrCiRecovery,
  runPrCiWatch,
  TRACKED_PR_LIMIT,
} from "./lib/pr_ci_watch.ts";
import { runCommand } from "./lib/workspace.ts";

const DAY_MS = 24 * 60 * 60_000;

async function recordFailureSafe(
  step: string,
  err: unknown,
  log: Logger,
): Promise<void> {
  const message = maskSecrets(err instanceof Error ? err.message : String(err));
  log.error(step, { error: message });
  try {
    await recordFailure({
      work_item_id: null,
      flow_path: "f/factory/watch_pr_ci",
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

export async function main(): Promise<PrCiWatchResult> {
  const log = logger("watch_pr_ci");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  // 無効のときは、修正中の行が無ければ何も読まずに終わる。回復の対象がある間だけ、GitHubを読む。
  if (
    !config.pr_ci_watch_enabled &&
    (await listFixingPrCiChecks(1)).length === 0
  ) {
    log.info("pr ci watch is disabled");
    return PR_CI_WATCH_IDLE_RESULT;
  }
  const ghToken = await wmill.getVariable("f/factory/github_token");
  const discordWebhookUrl = await wmill.getVariable(
    "f/factory/discord_webhook_url",
  );
  const client: GhClient = { run: runCommand, ghToken };

  // 名前の付け替えで別のアカウントを読まないよう、`repo_allowlist`は照合を通ったオーナーのものだけを通す。
  const verified = await filterVerifiedOwners(config.owners, {
    getAccountId: (name) => getAccountId(client, name),
    recordFailure: (step, err) => recordFailureSafe(step, err, log),
    addNotice: (record) => addNoticeUnlessUnresolved(record),
  });
  const deps: PrCiWatchDeps = {
    now: () => new Date(),
    log,
    instanceName: config.instance_name,
    ...buildRepoGates(config, verified.owners),
    listTrackedItems: async () => {
      const items = await listPrOpenIssueWorkItems(
        new Date(Date.now() - config.tracked_pr_days * DAY_MS),
        TRACKED_PR_LIMIT,
      );
      return items.map((item) => ({
        id: item.id,
        kind: item.kind,
        owner: item.owner,
        repo: item.repo,
        prUrl: item.pr_url,
      }));
    },
    getPr: (owner, repo, number) => getPr(client, owner, repo, number),
    listRuns: (owner, repo, headSha, headRef, options) =>
      listPrHeadWorkflowRuns(client, owner, repo, headSha, headRef, options),
    listRowsForPr: (owner, repo, prNumber) =>
      listPrCiChecksForPr(owner, repo, prNumber),
    record: (record) => recordPrCiCheck(record),
    listPending: (limit) => listPendingPrCiChecks(limit),
    listFailed: (limit) => listFailedPrCiChecks(limit),
    listNoCi: (checkedBefore, limit) =>
      listNoCiPrCiChecksToRecheck(checkedBefore, limit),
    transition: (id, from, to) => transitionPrCiCheck(id, from, to),
    listFixing: (limit) => listFixingPrCiChecks(limit),
    listOrphanFixing: (limit) => findOrphanFixingPrCiChecks(limit),
    readFixItem: (workItemId) =>
      readFixItemState(workItemId, {
        getWorkItem: (id) => getWorkItem(id),
        latestStatusNote: async (id, status) =>
          (await latestStatusEvent(id, status))?.note ?? null,
        hasPushedCommits: async (id) =>
          ((await latestFixRound(id))?.commit_shas.length ?? 0) > 0,
      }),
    release: (id, options) => releaseFixingPrCiCheck(id, options),
    touch: (id) => touchPrCiCheck(id),
    markNotified: (id, reason) => markPrCiNotified(id, reason),
    addNotice: (record) => addNoticeUnlessUnresolved(record),
    resolveNotices: (kind, messagePrefix, resolvedBy) =>
      resolveUnresolvedNoticesByPrefix(kind, messagePrefix, resolvedBy),
    notify: (event) => notifyBestEffort(discordWebhookUrl, event, log),
    recordFailure: (step, err) => recordFailureSafe(step, err, log),
  };
  if (!config.pr_ci_watch_enabled) {
    log.info("pr ci watch is disabled; recovering fixing rows only");
    const recovered = await runPrCiRecovery(deps);
    log.info("pr ci recovery finished", { ...recovered });
    return recovered;
  }
  const result = await runPrCiWatch(deps);
  log.info("pr ci watch finished", { ...result });
  return result;
}
