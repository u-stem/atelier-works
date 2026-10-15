// 5分ごとに、Factoryが作ったPRのマージの競合を検知する。競合したPRは要対応のnoticeとDiscordで知らせ、
// 競合が解けたら、noticeを自動で解決する。閉じたPRの行は整理する。
// PRにもリポジトリにも書き込まず、競合を解く作業も起動しない。
//
// 設定`pr_conflict_watch_enabled`が`false`のときは、GitHubもDBも読まず、何も書かずに終わる。
// `pr_ci_watch_enabled`には依らず、CIの監視とは独立に有効にできる。
//
// 流れと判断は`./lib/pr_conflict_watch.ts`にあり、このファイルは入出力をつなぐだけ。
// 対象は、許可リスト(`repo_allowlist`と照合済みの`owners`、常に対象の`factory_repo`)に合うリポジトリの、
// 開いているFactoryのPRである。人のPRは対象にしない。
// 列挙するリポジトリは、`pr_open`の作業項目を持つもの、競合の記録の行を持つもの、設定で明示されたもの、
// PATのアカウントが作った開いているPRを検索で見つけたものの和集合である。
// 作業項目は`cleanup_db`が消すので、PRがFactoryのものかは、ブランチ名の形とPATのアカウントが作者であることで決める。

// デプロイ先のサーバーの版に合わせて1.817.0に固定する。
import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "./lib/config.ts";
import { UNRESOLVABLE_NOTICE_KINDS } from "./lib/console_support.ts";
import {
  addNoticeUnlessUnresolved,
  listConflictedPrConflictChecks,
  listPrConflictRepos,
  listPrOpenRepos,
  markPrConflictNotified,
  recordFailure,
  recordPrConflict,
  resolveNoticeIfUnresolved,
  resolveUnresolvedNoticesByPrefix,
  settlePrConflictCheck,
  touchPrConflictCheck,
} from "./lib/db.ts";
import { notifyBestEffort } from "./lib/discord.ts";
import {
  type GhClient,
  getAccountId,
  getPr,
  getViewer,
  listOpenPullRequests,
  searchOpenAuthoredPrs,
} from "./lib/github.ts";
import { type Logger, logger, maskSecrets } from "./lib/log.ts";
import { filterVerifiedOwners } from "./lib/poll_support.ts";
import { buildRepoGates } from "./lib/pr_ci_watch.ts";
import {
  PR_CONFLICT_KIND,
  PR_CONFLICT_RESOLVED_BY,
} from "./lib/pr_conflict_support.ts";
import {
  configuredRepos,
  type PrConflictWatchResult,
  runPrConflictWatch,
  runPrConflictWatchIfEnabled,
} from "./lib/pr_conflict_watch.ts";
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
      flow_path: "f/factory/watch_pr_conflicts",
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

export async function main(): Promise<PrConflictWatchResult> {
  const log = logger("watch_pr_conflicts");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  return runPrConflictWatchIfEnabled(
    config.pr_conflict_watch_enabled,
    log,
    async () => {
      const ghToken = await wmill.getVariable("f/factory/github_token");
      const discordWebhookUrl = await wmill.getVariable(
        "f/factory/discord_webhook_url",
      );
      const client: GhClient = { run: runCommand, ghToken };

      // 名前の付け替えで別のアカウントを読まないよう、読み取りは照合を通ったオーナーのリポジトリだけにする。
      // 行を閉じる判定は、照合の一時的な失敗に左右されないよう、設定だけで決める。
      const verifiedOwners = (
        await filterVerifiedOwners(config.owners, {
          getAccountId: (name) => getAccountId(client, name),
          recordFailure: (step, err) => recordFailureSafe(step, err, log),
          addNotice: (record) => addNoticeUnlessUnresolved(record),
        })
      ).owners;
      const gates = buildRepoGates(config, verifiedOwners);

      const result = await runPrConflictWatch({
        now: () => new Date(),
        log,
        instanceName: config.instance_name,
        isRepoAllowed: gates.isRepoAllowed,
        isRepoConfigured: gates.isRepoConfigured,
        getViewer: () => getViewer(client),
        explicitRepos: configuredRepos(config),
        listOpenRepos: () => listPrOpenRepos(),
        listConflictRepos: () => listPrConflictRepos(),
        searchOwners: verifiedOwners,
        searchOpenRepos: async (owner, author) =>
          (
            await searchOpenAuthoredPrs(client, {
              scope: {
                kind: "owner",
                owner: owner.name,
                ownerKind: owner.kind,
              },
              author,
            })
          ).map(({ owner: itemOwner, repo }) => ({
            owner: itemOwner,
            repo,
          })),
        listOpenPrs: (owner, repo) => listOpenPullRequests(client, owner, repo),
        getPr: (owner, repo, number) => getPr(client, owner, repo, number),
        listConflicted: (limit) => listConflictedPrConflictChecks(limit),
        record: (observation) => recordPrConflict(observation),
        markNotified: (id) => markPrConflictNotified(id),
        resolveNotice: (id) =>
          resolveNoticeIfUnresolved(
            id,
            PR_CONFLICT_KIND,
            PR_CONFLICT_RESOLVED_BY,
            UNRESOLVABLE_NOTICE_KINDS,
          ),
        settle: (id, to) => settlePrConflictCheck(id, to),
        touch: (id) => touchPrConflictCheck(id),
        addNotice: (record) => addNoticeUnlessUnresolved(record),
        resolveNotices: (kind, messagePrefix, resolvedBy) =>
          resolveUnresolvedNoticesByPrefix(kind, messagePrefix, resolvedBy),
        notify: (event) => notifyBestEffort(discordWebhookUrl, event, log),
        recordFailure: (step, err) => recordFailureSafe(step, err, log),
      });
      log.info("pr conflict watch finished", { ...result });
      return result;
    },
  );
}
