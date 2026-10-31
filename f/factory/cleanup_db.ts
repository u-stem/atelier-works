// 毎日03:30(JST)に、保持期間を過ぎた行を`factory`スキーマから削除する。
// 放っておくと行が際限なく増えるため。対象は、`config.retention_work_items_days`を
// 過ぎた終端状態の作業項目(と、それを`ON DELETE CASCADE`で参照する表の行)と、
// `config.retention_logs_days`を過ぎた`job_failures`・`deployments`・
// 解決済みのnotice・判定済みの`main_ci_runs`・`pr_ci_checks`・`worker_samples`で、作業項目とは別々に掃除する。
// 判定を待つ`main_ci_runs`の行、判定を待つか修正中の`pr_ci_checks`の行、各リポジトリの最新の`main_ci_runs`の行は、古くても削除しない。
// 各PRの最新の`pr_ci_checks`の行は、保持期間の4倍まで残す。
// 競合から離れた`pr_conflict_checks`の行も、保持期間で削除する(競合したままの行は残す)。件数はログだけに残す。
// 収集の実行の`gh_collect_runs`も保持期間で削除する(所有者ごとの直近の成功と、`finished_at`のある直近の実行は残す)。件数はログだけに残す。
// 収集の詳細のうち、閉じたPRと一覧から外れたIssueの行も、`written_at`から保持期間を過ぎたものを削除する。開いている行は、古くても削除しない。件数はログだけに残す。
// 同じ期間を過ぎた未解決の`info`のnoticeは、削除せず解決済みにする。
// 手動投入の冪等キー`manual_intake_keys`は、`reserved_at`から作業項目と同じ保持期間(`retention_work_items_days`)を過ぎたものを削除する。件数はログだけに残す。
// Consoleの操作の記録`console_actions`は、設定ではなく固定の保持日数(90日)で削除する。件数はログだけに残す。
//
// 期限の計算と要約の整形は`./lib/cleanup_db_support.ts`にあり、
// このファイルは入出力をつなぐだけ。掃除は表ごとに独立しており、
// 1つの表の削除が失敗してもログと`factory.notices`の行に残して残りを続ける。
// 各catchの中の`addNoticeUnlessUnresolved`は例外を捕まえないので、DBに接続できないときは
// その呼び出しも失敗して`main`の外へ伝わる。
// こうして、接続障害を全件0件の結果として握りつぶさずに表に出す。
//
// 作業項目の要件定義ディレクトリの削除(`doc_dirs_deleted`)は、DBの掃除ではなく
// 失敗してもよいファイルの片付け。`deleteTerminalWorkItemsBefore`が成功した後に、
// それが返した削除済みの行の`{id, owner, repo, issue_number}`を使って実行する。
// ここでの失敗(DBの削除が実行されなかった場合を含む)も、他の掃除と同じく
// ログとnoticeに残し、残りの処理を止めない。

import * as wmill from "windmill-client@1.817.0";
import {
  type CleanupCounts,
  computeRetentionCutoffs,
  docDirsFor,
  summarizeCleanup,
} from "./lib/cleanup_db_support.ts";
import { loadConfig } from "./lib/config.ts";
import {
  consoleActionsCutoff,
  deleteExpiredActions,
} from "./lib/console_actions.ts";
import { INFO_NOTICE_KINDS } from "./lib/console_support.ts";
import {
  addNoticeUnlessUnresolved,
  type DeletedWorkItemRef,
  defaultSqlClient,
  deleteClosedGhDetailRowsBefore,
  deleteDeploymentsBefore,
  deleteGhCollectRunsBefore,
  deleteJobFailuresBefore,
  deleteMainCiRunsBefore,
  deleteManualIntakeKeysBefore,
  deletePrCiChecksBefore,
  deletePrConflictChecksBefore,
  deleteResolvedNoticesBefore,
  deleteTerminalWorkItemsBefore,
  deleteWorkerSamplesBefore,
  insertCleanupRun,
  resolveStaleInfoNoticesBefore,
} from "./lib/db.ts";
import { type Logger, logger, maskSecrets } from "./lib/log.ts";
import { REQUIREMENTS_BASE_DIR } from "./lib/requirements_template.ts";
import { removeEmptyDir, removePath } from "./lib/workspace.ts";

function errorMessage(err: unknown): string {
  return maskSecrets(err instanceof Error ? err.message : String(err));
}

/**
 * `cutoff`より前の終端状態の作業項目を削除し、件数と削除した行の参照を返す。
 * 失敗したらログとnoticeに残し、0件と空の`deleted`を返す。
 * 連鎖削除される`approval_requests`は同じ文の中で数えるので、
 * 2つの件数は常に同じ行の集合を指す。
 * `deleted`は`cleanupDocDirs`が要件定義ディレクトリを探すのに使う。
 * 削除に失敗したときは空になり、ディレクトリの掃除も正しく飛ばされる。
 */
async function cleanupWorkItems(
  cutoff: Date,
  log: Logger,
): Promise<
  Pick<CleanupCounts, "work_items_deleted" | "approval_requests_deleted"> & {
    readonly deleted: readonly DeletedWorkItemRef[];
  }
> {
  try {
    return await deleteTerminalWorkItemsBefore(cutoff);
  } catch (err) {
    const message = errorMessage(err);
    log.error("cleanup_db: failed to delete terminal work items", {
      error: message,
    });
    await addNoticeUnlessUnresolved({
      kind: "cleanup_db_failed",
      message: `終端work itemの削除に失敗しました: ${message}`,
    });
    return { work_items_deleted: 0, approval_requests_deleted: 0, deleted: [] };
  }
}

/**
 * 削除した作業項目の要件定義ディレクトリを消し、消せた数を返す。
 * `wi-<id>`は中身ごと消し、親の`issue-<N>`は空になった場合だけ消す。
 * 同じIssueの別の作業項目が自分の`wi-<id>`を持っていることがあるため。
 * 1件の失敗はログとnoticeに残して残りを続ける。
 * 残ったディレクトリはディスク使用量の問題にとどまり、
 * 対応するDBの行はどちらにしても削除済みなので、正しさには影響しない。
 */
async function cleanupDocDirs(
  deleted: readonly DeletedWorkItemRef[],
  log: Logger,
): Promise<number> {
  const dirs = docDirsFor(deleted, REQUIREMENTS_BASE_DIR);
  let deletedCount = 0;
  for (const { wiDir, issueDir } of dirs) {
    try {
      await removePath(wiDir);
      await removeEmptyDir(issueDir);
      deletedCount += 1;
    } catch (err) {
      const message = errorMessage(err);
      log.error("cleanup_db: failed to delete a requirements doc dir", {
        wiDir,
        error: message,
      });
      await addNoticeUnlessUnresolved({
        kind: "cleanup_db_failed",
        message: `要件定義ディレクトリの削除に失敗しました(${wiDir}): ${message}`,
      });
    }
  }
  return deletedCount;
}

async function cleanupJobFailures(cutoff: Date, log: Logger): Promise<number> {
  try {
    return await deleteJobFailuresBefore(cutoff);
  } catch (err) {
    const message = errorMessage(err);
    log.error("cleanup_db: failed to delete job_failures", { error: message });
    await addNoticeUnlessUnresolved({
      kind: "cleanup_db_failed",
      message: `失敗記録の削除に失敗しました: ${message}`,
    });
    return 0;
  }
}

async function cleanupDeployments(cutoff: Date, log: Logger): Promise<number> {
  try {
    return await deleteDeploymentsBefore(cutoff);
  } catch (err) {
    const message = errorMessage(err);
    log.error("cleanup_db: failed to delete deployments", { error: message });
    await addNoticeUnlessUnresolved({
      kind: "cleanup_db_failed",
      message: `デプロイ記録の削除に失敗しました: ${message}`,
    });
    return 0;
  }
}

/** 判定済みのmainのCIの記録を、最後の更新から保持期間を過ぎたものだけ削除する。判定を待つ行と、各リポジトリの最新の行は消さない。 */
async function cleanupMainCiRuns(cutoff: Date, log: Logger): Promise<number> {
  try {
    return await deleteMainCiRunsBefore(cutoff);
  } catch (err) {
    const message = errorMessage(err);
    log.error("cleanup_db: failed to delete main_ci_runs", { error: message });
    await addNoticeUnlessUnresolved({
      kind: "cleanup_db_failed",
      message: `mainのCIの記録の削除に失敗しました: ${message}`,
    });
    return 0;
  }
}

/**
 * 判定済みのPRのCIの記録を、最後の更新から保持期間を過ぎたものだけ削除する。
 * 判定を待つ行と修正中の行は消さない。各PRの最新の行は、保持期間の4倍を過ぎるまで消さない。
 */
async function cleanupPrCiChecks(
  cutoff: Date,
  latestCutoff: Date,
  log: Logger,
): Promise<number> {
  try {
    return await deletePrCiChecksBefore(cutoff, latestCutoff);
  } catch (err) {
    const message = errorMessage(err);
    log.error("cleanup_db: failed to delete pr_ci_checks", { error: message });
    await addNoticeUnlessUnresolved({
      kind: "cleanup_db_failed",
      message: `PRのCIの記録の削除に失敗しました: ${message}`,
    });
    return 0;
  }
}

/**
 * 競合から離れたPRの競合の記録を、最後の更新から保持期間を過ぎたものだけ削除する。
 * 競合したままの行は消さない。件数は`cleanup_runs`に記録せず、ログに残す。
 */
async function cleanupPrConflictChecks(
  cutoff: Date,
  log: Logger,
): Promise<number> {
  try {
    return await deletePrConflictChecksBefore(cutoff);
  } catch (err) {
    const message = errorMessage(err);
    log.error("cleanup_db: failed to delete pr_conflict_checks", {
      error: message,
    });
    await addNoticeUnlessUnresolved({
      kind: "cleanup_db_failed",
      message: `PRの競合の記録の削除に失敗しました: ${message}`,
    });
    return 0;
  }
}

/**
 * 収集の実行の記録を、始めた時刻から保持期間を過ぎたものだけ削除する。
 * 所有者ごとの直近の成功と、`finished_at`のある直近の実行は消さない。
 * 件数は`cleanup_runs`に記録せず、ログに残す。`gh_repos`は消さない。
 */
async function cleanupGhCollectRuns(
  cutoff: Date,
  log: Logger,
): Promise<number> {
  try {
    return await deleteGhCollectRunsBefore(cutoff);
  } catch (err) {
    const message = errorMessage(err);
    log.error("cleanup_db: failed to delete gh_collect_runs", {
      error: message,
    });
    await addNoticeUnlessUnresolved({
      kind: "cleanup_db_failed",
      message: `収集の実行の記録の削除に失敗しました: ${message}`,
    });
    return 0;
  }
}

/**
 * 収集の詳細のうち、閉じたPRと一覧から外れたIssueの行を、書いた時刻から保持期間を過ぎたものだけ削除する。
 * 開いている行(使用不可の行を含む)は消さない。件数は`cleanup_runs`に記録せず、ログに残す。
 */
async function cleanupGhDetailRows(cutoff: Date, log: Logger): Promise<number> {
  try {
    return await deleteClosedGhDetailRowsBefore(cutoff);
  } catch (err) {
    const message = errorMessage(err);
    log.error("cleanup_db: failed to delete gh detail rows", {
      error: message,
    });
    await addNoticeUnlessUnresolved({
      kind: "cleanup_db_failed",
      message: `収集の詳細の行の削除に失敗しました: ${message}`,
    });
    return 0;
  }
}

/** workerの負荷の記録を、測った時刻から保持期間を過ぎたものだけ削除する。 */
async function cleanupWorkerSamples(
  cutoff: Date,
  log: Logger,
): Promise<number> {
  try {
    return await deleteWorkerSamplesBefore(cutoff);
  } catch (err) {
    const message = errorMessage(err);
    log.error("cleanup_db: failed to delete worker_samples", {
      error: message,
    });
    await addNoticeUnlessUnresolved({
      kind: "cleanup_db_failed",
      message: `workerの負荷の記録の削除に失敗しました: ${message}`,
    });
    return 0;
  }
}

/**
 * 手動投入の冪等キーを、予約した時刻から作業項目と同じ保持期間を過ぎたものだけ削除する。
 * 件数は`cleanup_runs`に記録せず、ログに残す。
 */
async function cleanupManualIntakeKeys(
  cutoff: Date,
  log: Logger,
): Promise<number> {
  try {
    return await deleteManualIntakeKeysBefore(cutoff);
  } catch (err) {
    const message = errorMessage(err);
    log.error("cleanup_db: failed to delete manual_intake_keys", {
      error: message,
    });
    await addNoticeUnlessUnresolved({
      kind: "cleanup_db_failed",
      message: `手動投入のキーの削除に失敗しました: ${message}`,
    });
    return 0;
  }
}

/**
 * Consoleの操作の記録を、記録した時刻から固定の保持日数(`CONSOLE_ACTIONS_RETENTION_DAYS`)を過ぎたものだけ削除する。
 * 保持日数は設定の項目にしない。記録を短くすると、誤操作の追跡が効かなくなるためである。
 * 件数は`cleanup_runs`に記録せず、ログに残す。
 */
async function cleanupConsoleActions(now: Date, log: Logger): Promise<number> {
  try {
    return await deleteExpiredActions(
      consoleActionsCutoff(now),
      defaultSqlClient,
    );
  } catch (err) {
    const message = errorMessage(err);
    log.error("cleanup_db: failed to delete console_actions", {
      error: message,
    });
    await addNoticeUnlessUnresolved({
      kind: "cleanup_db_failed",
      message: `Consoleの操作の記録の削除に失敗しました: ${message}`,
    });
    return 0;
  }
}

/** 解決済みの通知を、解決の時刻から保持期間を過ぎたものだけ削除する。 */
async function cleanupNotices(cutoff: Date, log: Logger): Promise<number> {
  try {
    return await deleteResolvedNoticesBefore(cutoff);
  } catch (err) {
    const message = errorMessage(err);
    log.error("cleanup_db: failed to delete resolved notices", {
      error: message,
    });
    await addNoticeUnlessUnresolved({
      kind: "cleanup_db_failed",
      message: `解決済みの通知の削除に失敗しました: ${message}`,
    });
    return 0;
  }
}

/**
 * 保持期間を過ぎた未解決の`info`の通知を、削除せず解決済みにする。
 * `info`の通知はConsoleの一覧から7日で外れ、誰も解決しないので、溜まり続けないようにここで解決済みにする。
 * 解決できない種類の通知(`UNRESOLVABLE_NOTICE_KINDS`)は、`design_enabled_ignored`(`action`)を除いて`info`なので、この対象に入る。
 * `design_enabled_ignored`は`action`なのでこの対象に入らず、設定が直ると自己更新が解決する。
 * 痕跡を解決済みの履歴に残し、その後は`cleanupNotices`が通常の保持期間で消す。
 * `cleanupNotices`とは別に呼び、片方が失敗してももう片方の件数を捨てない。
 */
async function cleanupInfoNotices(cutoff: Date, log: Logger): Promise<number> {
  try {
    return await resolveStaleInfoNoticesBefore(cutoff, INFO_NOTICE_KINDS);
  } catch (err) {
    const message = errorMessage(err);
    log.error("cleanup_db: failed to resolve stale info notices", {
      error: message,
    });
    await addNoticeUnlessUnresolved({
      kind: "cleanup_db_failed",
      message: `古い情報の通知の解決に失敗しました: ${message}`,
    });
    return 0;
  }
}

/**
 * 今回の実行結果を`factory.cleanup_runs`に記録する。
 * 失敗しても他の掃除と同じくログとnoticeに残すだけで、ジョブは失敗させない。
 * この時点で削除そのものは成功しているか、個別に処理済みだから。
 */
async function recordRun(counts: CleanupCounts, log: Logger): Promise<void> {
  try {
    await insertCleanupRun(counts);
  } catch (err) {
    const message = errorMessage(err);
    log.error("cleanup_db: failed to record cleanup_runs row", {
      error: message,
    });
    await addNoticeUnlessUnresolved({
      kind: "cleanup_db_failed",
      message: `掃除結果の記録に失敗しました: ${message}`,
    });
  }
}

export async function main(): Promise<CleanupCounts> {
  const log = logger("cleanup_db");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const cutoffs = computeRetentionCutoffs(new Date(), config);

  const workItems = await cleanupWorkItems(cutoffs.workItemsBefore, log);
  const docDirsDeleted = await cleanupDocDirs(workItems.deleted, log);
  const jobFailuresDeleted = await cleanupJobFailures(cutoffs.logsBefore, log);
  const deploymentsDeleted = await cleanupDeployments(cutoffs.logsBefore, log);
  const noticesDeleted = await cleanupNotices(cutoffs.logsBefore, log);
  const infoNoticesResolved = await cleanupInfoNotices(cutoffs.logsBefore, log);
  const mainCiRunsDeleted = await cleanupMainCiRuns(cutoffs.logsBefore, log);
  const prCiChecksDeleted = await cleanupPrCiChecks(
    cutoffs.logsBefore,
    cutoffs.latestLogsBefore,
    log,
  );
  const prConflictChecksDeleted = await cleanupPrConflictChecks(
    cutoffs.logsBefore,
    log,
  );
  const ghCollectRunsDeleted = await cleanupGhCollectRuns(
    cutoffs.logsBefore,
    log,
  );
  const ghDetailRowsDeleted = await cleanupGhDetailRows(
    cutoffs.logsBefore,
    log,
  );
  const workerSamplesDeleted = await cleanupWorkerSamples(
    cutoffs.logsBefore,
    log,
  );

  const manualIntakeKeysDeleted = await cleanupManualIntakeKeys(
    cutoffs.workItemsBefore,
    log,
  );

  const consoleActionsDeleted = await cleanupConsoleActions(new Date(), log);

  const counts: CleanupCounts = {
    work_items_deleted: workItems.work_items_deleted,
    approval_requests_deleted: workItems.approval_requests_deleted,
    job_failures_deleted: jobFailuresDeleted,
    deployments_deleted: deploymentsDeleted,
    notices_deleted: noticesDeleted,
    info_notices_resolved: infoNoticesResolved,
    main_ci_runs_deleted: mainCiRunsDeleted,
    worker_samples_deleted: workerSamplesDeleted,
    pr_ci_checks_deleted: prCiChecksDeleted,
    doc_dirs_deleted: docDirsDeleted,
  };

  await recordRun(counts, log);
  log.info(summarizeCleanup(counts), {
    ...counts,
    pr_conflict_checks_deleted: prConflictChecksDeleted,
    gh_collect_runs_deleted: ghCollectRunsDeleted,
    gh_detail_rows_deleted: ghDetailRowsDeleted,
    manual_intake_keys_deleted: manualIntakeKeysDeleted,
    console_actions_deleted: consoleActionsDeleted,
  });
  return counts;
}
