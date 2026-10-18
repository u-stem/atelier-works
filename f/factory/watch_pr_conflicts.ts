// 5分ごとに、Factoryが作ったPRのマージの競合を検知する。競合したPRは要対応のnoticeとDiscordで知らせ、
// 競合が解けたら、noticeを自動で解決する。閉じたPRの行は整理する。
// このスクリプト自身は、PRにもリポジトリにも書き込まない。
//
// 設定`pr_conflict_fix_enabled`が`true`のときは、競合した行を直す作業項目(`pr_fix`の競合回)を起動する。
// 起動の前に、競合を始めてから`pr_conflict_fix_notify_grace_min`分は通知を待つ。
// 起動しない理由(保留)は行に書き、最終の保留は待たずに通知する。
// 直す作業項目が結ばれた行の回復(結びを外し、止まった理由を保留に写す)は、`pr_conflict_fix_enabled`に依らず、
// 通知の判断より先に毎回行う。作業項目が動いている間は、設定を無効にしても通知せず待つ。
// 回復は、`pr_conflict_watch_enabled`が`true`の間だけ動く。無効にする前に、直す作業項目が終わるのを待つ。
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
import { AUTO_RETRY_REASON_PREFIXES } from "./lib/auto_retry_reasons.ts";
import { dailyBudgetStatus } from "./lib/claude.ts";
import { loadConfig } from "./lib/config.ts";
import { hasConflictFixSkillMarker } from "./lib/conflict_fix_round.ts";
import { UNRESOLVABLE_NOTICE_KINDS } from "./lib/console_support.ts";
import {
  addNoticeUnlessUnresolved,
  claimPrConflictForFix,
  countPrConflictFixRounds,
  getMainCiStateBySha,
  getWorkItem,
  latestConflictFixSettledAt,
  latestFixRound,
  latestStatusEvent,
  listActivePrFixWorkItems,
  listConflictedPrConflictChecks,
  listPrConflictFixing,
  listPrConflictRepos,
  listPrOpenRepos,
  markPrConflictNotified,
  readGhOwnerOpenPullRequests,
  recordFailure,
  recordPrConflict,
  releasePrConflictFix,
  resolveNoticeIfUnresolved,
  resolveUnresolvedNoticesByPrefix,
  setFlowJobId,
  setPrConflictFixHold,
  settlePrConflictCheck,
  touchPrConflictCheck,
  updateStatusIfCurrent,
} from "./lib/db.ts";
import { notifyBestEffort } from "./lib/discord.ts";
import { ghDetailStaleAfterMs } from "./lib/gh_collect_read.ts";
import {
  type GhClient,
  getAccountId,
  getBranchSha,
  getDefaultBranch,
  getFileAtRef,
  getPr,
  getViewer,
  listOpenPullRequests,
  listPrCommitMessages,
  parseGitHubRepoUrl,
  searchOpenAuthoredPrs,
} from "./lib/github.ts";
import { type Logger, logger, maskSecrets } from "./lib/log.ts";
import { filterVerifiedOwners } from "./lib/poll_support.ts";
import { buildRepoGates } from "./lib/pr_ci_watch.ts";
import { readConflictFixItemState } from "./lib/pr_conflict_fix_recovery.ts";
import {
  PR_CONFLICT_KIND,
  PR_CONFLICT_RESOLVED_BY,
} from "./lib/pr_conflict_support.ts";
import {
  configuredRepos,
  type PrConflictFixDeps,
  type PrConflictRecoveryDeps,
  type PrConflictWatchResult,
  runPrConflictWatch,
  runPrConflictWatchIfEnabled,
} from "./lib/pr_conflict_watch.ts";
import { launchPrFixFlow } from "./lib/pr_fix_launch.ts";
import type { FactoryConfig, GhSource, WorkItemStatus } from "./lib/types.ts";
import { runCommand } from "./lib/workspace.ts";

/** 起動の依存が呼ぶ読み取り。テストで差し替える。 */
export type ConflictFixLookups = {
  readonly getBranchSha: typeof getBranchSha;
  readonly getMainCiStateBySha: typeof getMainCiStateBySha;
  readonly getFileAtRef: typeof getFileAtRef;
};

/** 回復の依存が呼ぶ読み取りと書き込み。テストで差し替える。 */
export type ConflictRecoveryLookups = {
  readonly getWorkItem: (id: number) => Promise<{
    status: WorkItemStatus;
    flow_job_id: string | null;
    conflict_episode: number | null;
  } | null>;
  readonly latestStatusEvent: (
    id: number,
    status: WorkItemStatus,
  ) => Promise<{ note: string | null } | null>;
  readonly latestFixRound: (
    id: number,
  ) => Promise<{ commit_shas: readonly string[] } | null>;
  readonly listPrConflictFixing: typeof listPrConflictFixing;
  readonly releasePrConflictFix: typeof releasePrConflictFix;
};

/** factory-fixスキルの、Factoryのcloneの中での位置。`pr_fix_apply`が読むファイルと同じである。 */
const FACTORY_FIX_SKILL_PATH = ".claude/skills/factory-fix/SKILL.md";

/**
 * 競合を直す作業項目を起動する依存を組む。設定で無効なら`undefined`を返す。
 * スキルのマーカーは、`pr_fix`が読むcloneと同じブランチ(`factory_branch`)のファイルで確かめる。
 * mainのCIは、既定のブランチの先頭のコミットの記録で確かめる。
 */
export function buildConflictFixDeps(
  config: FactoryConfig,
  client: GhClient,
  lookups: Partial<ConflictFixLookups> = {},
): PrConflictFixDeps | undefined {
  const read: ConflictFixLookups = {
    getBranchSha,
    getMainCiStateBySha,
    getFileAtRef,
    ...lookups,
  };
  const since = config.pr_conflict_fix_enabled_since;
  if (!config.pr_conflict_fix_enabled || since === null) return undefined;
  return {
    maxRounds: config.pr_conflict_fix_max_rounds,
    maxRoundsPerPr: config.pr_conflict_fix_max_rounds_per_pr,
    enabledSince: since,
    graceMin: config.pr_conflict_fix_notify_grace_min,
    hasActiveFix: async (owner, repo, prNumber) =>
      (await listActivePrFixWorkItems(owner, repo, prNumber)).length > 0,
    getDefaultBranch: (owner, repo) => getDefaultBranch(client, owner, repo),
    listCommits: (owner, repo, prNumber) =>
      listPrCommitMessages(client, owner, repo, prNumber),
    // `factory_repo`の解釈もここで行う。解釈に失敗しても、ほかの処理を止めず、行単位の失敗として記録される。
    hasSkillMarker: async () => {
      const factoryRepo = parseGitHubRepoUrl(config.factory_repo);
      const text = await read.getFileAtRef(
        client,
        factoryRepo.owner,
        factoryRepo.repo,
        FACTORY_FIX_SKILL_PATH,
        config.factory_branch,
      );
      return text !== null && hasConflictFixSkillMarker(text);
    },
    budgetExceeded: async () => (await dailyBudgetStatus(config)).exceeded,
    mainCiState: async (owner, repo, defaultBranch) =>
      read.getMainCiStateBySha(
        owner,
        repo,
        await read.getBranchSha(client, owner, repo, defaultBranch),
      ),
    countEpisodeRounds: (checkId, episode) =>
      countPrConflictFixRounds(
        { kind: "episode", checkId, episode },
        AUTO_RETRY_REASON_PREFIXES,
      ),
    countPrRounds: (owner, repo, prNumber) =>
      countPrConflictFixRounds(
        { kind: "pr", owner, repo, prNumber },
        AUTO_RETRY_REASON_PREFIXES,
      ),
    lastFixSettledAt: (owner, repo, prNumber) =>
      latestConflictFixSettledAt(owner, repo, prNumber),
    setHold: (id, reason, expected) =>
      setPrConflictFixHold(id, reason, { expected }),
    claim: (input) => claimPrConflictForFix(input),
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
    release: (id, options) => releasePrConflictFix(id, options),
  };
}

/**
 * 直す作業項目が結ばれた行を戻す依存を組む。設定に依らず組む。
 * 作業項目の注記は、ラウンドを数える式(`countPrConflictFixRounds`)と同じく、
 * 今の状態へ移った最新の遷移のものを読む(`latestStatusEvent`)。
 */
export function buildConflictRecoveryDeps(
  lookups: Partial<ConflictRecoveryLookups> = {},
): PrConflictRecoveryDeps {
  const read: ConflictRecoveryLookups = {
    getWorkItem,
    latestStatusEvent,
    latestFixRound,
    listPrConflictFixing,
    releasePrConflictFix,
    ...lookups,
  };
  return {
    listFixing: (limit) => read.listPrConflictFixing(limit),
    readFixItem: (workItemId, rowEpisode) =>
      readConflictFixItemState(workItemId, rowEpisode, {
        getWorkItem: (id) => read.getWorkItem(id),
        latestStatusNote: async (id, status) =>
          (await read.latestStatusEvent(id, status))?.note ?? null,
        hasPushedCommits: async (id) =>
          ((await read.latestFixRound(id))?.commit_shas.length ?? 0) > 0,
      }),
    release: (id, options) => read.releasePrConflictFix(id, options),
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

/**
 * 設定`gh_source_pr_conflict_watch`と収集の設定から、この回の読み取り元を決める。
 */
export function resolveConflictSource(
  _config: Pick<
    FactoryConfig,
    | "gh_source_pr_conflict_watch"
    | "gh_collect_enabled"
    | "gh_collect_detail_enabled"
  >,
  _log: Logger,
): GhSource {
  return "search";
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

      const fix = buildConflictFixDeps(config, client);
      const recovery = buildConflictRecoveryDeps();
      const result = await runPrConflictWatch({
        ...(fix === undefined ? { recovery } : { recovery, fix }),
        now: () => new Date(),
        log,
        instanceName: config.instance_name,
        isRepoAllowed: gates.isRepoAllowed,
        isRepoConfigured: gates.isRepoConfigured,
        getViewer: () => getViewer(client),
        source: "search",
        staleAfterMs: ghDetailStaleAfterMs(config.owners.length),
        readOwnerPrs: (owner) => readGhOwnerOpenPullRequests(owner),
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
