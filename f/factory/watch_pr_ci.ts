// 5分ごとに、Factoryが作ったPRのCI(GitHub Actionsのpull_requestとpushの実行)を、
// headのコミット単位で判定する。失敗したheadは要対応のnoticeとDiscordで知らせ、
// 同じPRのheadが通ったら、失敗のnoticeを自動で解決する。閉じたPRの行は整理する。
// PRにもリポジトリにも書き込まず、ログも読まない。
//
// 設定`pr_ci_watch_human_prs`が真のときは、許可された人(PATのアカウントと`allowed_labeler_logins`)が作った
// PR(開いていて、下書きでなく、forkでなく、Factoryが作っていないもの)も同じ手順で判定し、失敗を知らせる。
// 人のPRの失敗は、自動修正の設定に関わらず確定した時点で知らせ、直す作業項目は起動しない。
// PATのアカウントを読めないときは、人のPRの発見だけを飛ばす。
//
// 設定`pr_ci_fix_enabled`が真のときは、失敗した行を直す作業項目(pr_fixのCI回)を起動する。
// ログを読んでClaudeに渡すのは、起動した作業項目である。
// 自動で直す対象の失敗は、確定した時点では通知せず、直せるかが決まるたびに通知し、同じ状態では重ねない。
// 決まるのは、決定的な保留になったとき、直す回数の上限に達したとき、一時的な保留が続いたとき、
// 保険の時間がたったときである。
// 無効のときと、有効にした時刻より前の失敗は、確定した時点ですぐ通知する。
// 失敗を直す作業項目が終わった`fixing`の行は、回復で`failed`か`superseded`に戻す。
// 回復と、保留した失敗の通知は、設定`pr_ci_watch_enabled`に依らず動く。
// 保留した通知はDBだけを読み、GitHubを読まない。作業項目の起動は、監視が有効なときだけ行う。
//
// 流れと判断は`./lib/pr_ci_watch.ts`にあり、このファイルは入出力をつなぐだけ。
// FactoryのPRの対象は、作業項目の`pr_url`から引いたPRのうち、許可リスト(`repo_allowlist`と照合済みの`owners`、
// 常に対象の`factory_repo`)に合うリポジトリのものである。人のPRも、同じ許可リストに合うリポジトリに限る。
// GITHUB_TOKENにActionsの読み取り権限が無いリポジトリは、`pr_ci_check_denied`のnoticeで知らせる。
// 設定`pr_ci_watch_enabled`が`false`のときは、回復と保留した通知だけを行い、発見と判定と新しい失敗の通知はしない。
// このときはオーナーの照合も行わず、設定に合うリポジトリのPRだけを読む(`buildRecoveryRepoGates`)。
// 照合に伴う通知は足さない。ただし、回復がPRを読めず403か404になると、`pr_ci_check_denied`は足しうる。
// 判定が動かない間は、この通知は解決されない。
// 回復の対象の行も、通知を保留した行も無ければ、何も読まずに終わる。

// デプロイ先のサーバーの版に合わせて1.817.0に固定する。
import * as wmill from "windmill-client@1.817.0";
import { hasCiFixSkillMarker } from "./lib/ci_fix_round.ts";
import { dailyBudgetStatus } from "./lib/claude.ts";
import { loadConfig } from "./lib/config.ts";
import {
  addNoticeUnlessUnresolved,
  claimPrCiCheckForFix,
  countPrCiFixRounds,
  findOrphanFixingPrCiChecks,
  getWorkItem,
  hasPrReviewForHead,
  isLatestMainCiRunFailed,
  latestFixRound,
  latestStatusEvent,
  listActivePrFixWorkItems,
  listClaimablePrCiChecks,
  listFailedPrCiChecks,
  listFixingPrCiChecks,
  listNoCiPrCiChecksToRecheck,
  listPendingPrCiChecks,
  listPrCiChecksForPr,
  listPrOpenIssueWorkItems,
  listUnnotifiedFailedPrCiChecks,
  markPrCiNotified,
  recordFailure,
  recordPrCiCheck,
  releaseFixingPrCiCheck,
  resolveUnresolvedNoticesByPrefix,
  setFlowJobId,
  setPrCiFixHold,
  touchPrCiCheck,
  transitionPrCiCheck,
  updateStatusIfCurrent,
} from "./lib/db.ts";
import { notifyBestEffort } from "./lib/discord.ts";
import {
  type GhClient,
  getAccountId,
  getFileAtRef,
  getPr,
  getPrWithoutWait,
  getViewer,
  listPrCommitMessages,
  listPrHeadWorkflowRuns,
  listWorkflowRunJobs,
  parseGitHubRepoUrl,
  searchOpenAuthoredPrs,
} from "./lib/github.ts";
import { type Logger, logger, maskSecrets } from "./lib/log.ts";
import { filterVerifiedOwners } from "./lib/poll_support.ts";
import { readFixItemState } from "./lib/pr_ci_fix_recovery.ts";
import type { PrCiNotifyPolicy } from "./lib/pr_ci_notify.ts";
import { PR_CI_FIX_TEMPORARY_HOLD_REASONS } from "./lib/pr_ci_support.ts";
import {
  buildHumanDiscovery,
  buildRecoveryRepoGates,
  buildRepoGates,
  PR_CI_WATCH_IDLE_RESULT,
  type PrCiClaimDeps,
  type PrCiWatchDeps,
  type PrCiWatchResult,
  runPrCiRecovery,
  runPrCiWatch,
  TRACKED_PR_LIMIT,
} from "./lib/pr_ci_watch.ts";
import { launchPrFixFlow } from "./lib/pr_fix_launch.ts";
import type { FactoryConfig } from "./lib/types.ts";
import { runCommand } from "./lib/workspace.ts";

const DAY_MS = 24 * 60 * 60_000;

/** factory-fixスキルの、Factoryのcloneの中での位置。`pr_fix_apply`が読むファイルと同じである。 */
const FACTORY_FIX_SKILL_PATH = ".claude/skills/factory-fix/SKILL.md";

/**
 * 失敗した行から直す作業項目を起動する依存を組む。
 * 設定で起動が有効で、有効にした時刻があるときだけ組み、そうでなければ`undefined`を返す。
 * スキルのマーカーは、`pr_fix`が読むcloneと同じブランチ(`factory_branch`)のファイルで確かめる。
 */
function buildClaimDeps(
  config: FactoryConfig,
  client: GhClient,
): PrCiClaimDeps | undefined {
  const since = config.pr_ci_fix_enabled_since;
  if (!config.pr_ci_fix_enabled || since === null) return undefined;
  return {
    maxRounds: config.pr_ci_fix_max_rounds,
    enabledSince: since,
    listCandidates: (from, limit) =>
      listClaimablePrCiChecks(from, PR_CI_FIX_TEMPORARY_HOLD_REASONS, limit),
    hasActiveFix: async (owner, repo, prNumber) =>
      (await listActivePrFixWorkItems(owner, repo, prNumber)).length > 0,
    hasReview: (owner, repo, prNumber, headSha) =>
      hasPrReviewForHead(owner, repo, prNumber, headSha),
    listCommits: (owner, repo, prNumber) =>
      listPrCommitMessages(client, owner, repo, prNumber),
    // `factory_repo`の解釈もここで行う。解釈に失敗しても、ほかの処理を止めず、行単位の失敗として記録される。
    hasSkillMarker: async () => {
      const factoryRepo = parseGitHubRepoUrl(config.factory_repo);
      const text = await getFileAtRef(
        client,
        factoryRepo.owner,
        factoryRepo.repo,
        FACTORY_FIX_SKILL_PATH,
        config.factory_branch,
      );
      return text !== null && hasCiFixSkillMarker(text);
    },
    listJobs: (owner, repo, runId, headSha) =>
      listWorkflowRunJobs(client, owner, repo, runId, headSha),
    budgetExceeded: async () => (await dailyBudgetStatus(config)).exceeded,
    mainCiFailed: (owner, repo) => isLatestMainCiRunFailed(owner, repo),
    countRounds: (owner, repo, prNumber) =>
      countPrCiFixRounds(owner, repo, prNumber),
    setHold: (id, reason, expected, resetNotified) =>
      setPrCiFixHold(id, reason, { expected, resetNotified }),
    claim: (input) => claimPrCiCheckForFix(input),
    launch: async (workItemId) => {
      await launchPrFixFlow(workItemId, {
        runFlowAsync: (flowPath, args) => wmill.runFlowAsync(flowPath, args),
        setFlowJobId,
      });
    },
    failFixItem: async (workItemId, note) => {
      await updateStatusIfCurrent(workItemId, "fixing", "failed", note);
    },
    cancelFlow: async (jobId, reason) => {
      await wmill.cancelJob(jobId, reason);
    },
  };
}

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
  // 無効のときは、修正中の行も、通知を保留した行も無ければ、何も読まずに終わる。
  // 回復の対象がある間だけGitHubを読み、保留した通知はDBだけを読んで出す。
  if (
    !config.pr_ci_watch_enabled &&
    (await listFixingPrCiChecks(1)).length === 0 &&
    (await listUnnotifiedFailedPrCiChecks(1)).length === 0
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
  // 無効のときは、照合のGitHubの呼び出しとnoticeの追加を避けるため、照合せずに設定だけで決める。
  const verifiedOwners = config.pr_ci_watch_enabled
    ? (
        await filterVerifiedOwners(config.owners, {
          getAccountId: (name) => getAccountId(client, name),
          recordFailure: (step, err) => recordFailureSafe(step, err, log),
          addNotice: (record) => addNoticeUnlessUnresolved(record),
        })
      ).owners
    : null;
  const gates =
    verifiedOwners === null
      ? buildRecoveryRepoGates(config)
      : buildRepoGates(config, verifiedOwners);
  const claim = config.pr_ci_watch_enabled
    ? buildClaimDeps(config, client)
    : undefined;
  // 人のPRの発見は監視が有効なときだけ行う。無効のときは、PATのアカウントも読まない。
  const humanDiscovery =
    verifiedOwners === null
      ? undefined
      : await buildHumanDiscovery({
          config,
          verifiedOwners,
          getViewer: () => getViewer(client),
          getPr: (owner, repo, number) =>
            getPrWithoutWait(client, owner, repo, number),
          search: (scope, author) =>
            searchOpenAuthoredPrs(client, { scope, author }),
          recordFailure: (step, err) => recordFailureSafe(step, err, log),
        });
  // 監視が無効なら起動もしないので、保留していた通知はすぐ出す。
  const notifyPolicy: PrCiNotifyPolicy = {
    fixEnabled: config.pr_ci_watch_enabled && config.pr_ci_fix_enabled,
    fixEnabledSince: config.pr_ci_fix_enabled_since,
    claudeTimeoutSec: config.claude_timeout_sec,
  };
  const deps: PrCiWatchDeps = {
    ...(claim === undefined ? {} : { claim }),
    ...(humanDiscovery === undefined ? {} : { humanDiscovery }),
    notifyPolicy,
    now: () => new Date(),
    log,
    instanceName: config.instance_name,
    ...gates,
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
    listUnnotifiedFailed: (limit) => listUnnotifiedFailedPrCiChecks(limit),
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
