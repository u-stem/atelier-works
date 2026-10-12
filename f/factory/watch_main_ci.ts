// 5分ごとに、対象リポジトリの既定のブランチ(main)へのpushで動いたGitHub Actionsの結果を、
// コミット単位で判定する。失敗したコミットは要対応のnoticeとDiscordで知らせ、
// 同じリポジトリの新しいコミットが通ったら、失敗のnoticeを自動で解決する。
// 作業項目には触れない、読み取りだけの監視である。
//
// 流れと判断は`./lib/main_ci_watch.ts`にあり、このファイルは入出力をつなぐだけ。
// 対象は`factory_repo`と`repo_allowlist`である。`repo_allowlist`は照合を通ったオーナーのものだけを通し、
// `factory_repo`は照合の対象外で常に対象にする。`repo_allowlist`が空なら`factory_repo`だけを見る。
// GITHUB_TOKENにActionsの読み取り権限が無いリポジトリは、`main_ci_check_denied`のnoticeで知らせる。

// デプロイ先のサーバーの版に合わせて1.817.0に固定する。
import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "./lib/config.ts";
import {
  addNoticeUnlessUnresolved,
  getPreviousMainCiRun,
  hasMainCiRuns,
  hasPassedMainCiRunAfter,
  latestMainCiRunCreatedAt,
  listMainCiRunsBySha,
  listPendingMainCiRuns,
  recordFailure,
  recordMainCiRun,
  resolveUnresolvedNoticesByPrefix,
  transitionMainCiRun,
} from "./lib/db.ts";
import { notifyBestEffort } from "./lib/discord.ts";
import { getDefaultBranch } from "./lib/drawio_viewer_bump_github.ts";
import { type GhClient, getAccountId, listWorkflowRuns } from "./lib/github.ts";
import { type Logger, logger, maskSecrets } from "./lib/log.ts";
import {
  listMainCiTargets,
  type MainCiWatchResult,
  runMainCiWatch,
} from "./lib/main_ci_watch.ts";
import { filterVerifiedOwners } from "./lib/poll_support.ts";
import { runCommand } from "./lib/workspace.ts";

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
      flow_path: "f/factory/watch_main_ci",
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

export async function main(): Promise<MainCiWatchResult> {
  const log = logger("watch_main_ci");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
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
  const { targets, invalid } = listMainCiTargets({
    owners: verified.owners,
    repo_allowlist: config.repo_allowlist,
    factory_repo: config.factory_repo,
  });
  if (invalid.length > 0) {
    // URLに認証情報が埋め込まれていることがあるので、値は載せない。
    log.warn("repo_allowlist has entries that are not GitHub repository URLs", {
      count: invalid.length,
    });
  }

  const result = await runMainCiWatch(targets, {
    now: () => new Date(),
    log,
    instanceName: config.instance_name,
    getDefaultBranch: (owner, repo) => getDefaultBranch(client, owner, repo),
    listRuns: (owner, repo, branch, headSha) =>
      listWorkflowRuns(client, owner, repo, branch, headSha),
    hasRows: (owner, repo) => hasMainCiRuns(owner, repo),
    latestRunCreatedAt: (owner, repo) => latestMainCiRunCreatedAt(owner, repo),
    listRowsBySha: (owner, repo, shas) =>
      listMainCiRunsBySha(owner, repo, shas),
    record: (record) => recordMainCiRun(record),
    listPending: (limit) => listPendingMainCiRuns(limit),
    getPrevious: (owner, repo, runCreatedAt) =>
      getPreviousMainCiRun(owner, repo, runCreatedAt),
    hasNewerPassed: (owner, repo, runCreatedAt) =>
      hasPassedMainCiRunAfter(owner, repo, runCreatedAt),
    transition: (id, to) => transitionMainCiRun(id, to),
    addNotice: (record) => addNoticeUnlessUnresolved(record),
    resolveNotices: (kind, messagePrefix, resolvedBy) =>
      resolveUnresolvedNoticesByPrefix(kind, messagePrefix, resolvedBy),
    notify: (event) => notifyBestEffort(discordWebhookUrl, event, log),
    recordFailure: (step, err) => recordFailureSafe(step, err, log),
  });
  log.info("main ci watch finished", { ...result });
  return result;
}
