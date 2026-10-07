// 毎日03:30(JST)に、保持期間を過ぎた行を`factory`スキーマから削除する。
// 放っておくと行が際限なく増えるため。対象は、`config.retention_work_items_days`を
// 過ぎた終端状態のwork item(と連鎖削除される`requirement_drafts`・`approvals`・
// `agent_runs`・`approval_requests`)と、`config.retention_logs_days`を過ぎた
// `job_failures`・`deployments`・解決済みのnoticeで、work itemとは別々に掃除する。
//
// 期限の計算と要約の整形は`./lib/cleanup_db_support.ts`にあり、
// このファイルは入出力をつなぐだけ。掃除は表ごとに独立しており、
// 1つの表の削除が失敗してもログと`factory.notices`の行に残して残りを続ける。
// 各catchの中の`addNotice`は例外を捕まえないので、DBに接続できないときは
// その呼び出しも失敗して`main`の外へ伝わる。
// こうして、接続障害を全件0件の結果として握りつぶさずに表に出す。
//
// work itemの要件定義ディレクトリの削除(`doc_dirs_deleted`)は、DBの掃除ではなく
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
  addNotice,
  type DeletedWorkItemRef,
  deleteDeploymentsBefore,
  deleteJobFailuresBefore,
  deleteResolvedNoticesBefore,
  deleteTerminalWorkItemsBefore,
  insertCleanupRun,
} from "./lib/db.ts";
import { type Logger, logger, maskSecrets } from "./lib/log.ts";
import { REQUIREMENTS_BASE_DIR } from "./lib/requirements_template.ts";
import { removeEmptyDir, removePath } from "./lib/workspace.ts";

function errorMessage(err: unknown): string {
  return maskSecrets(err instanceof Error ? err.message : String(err));
}

/**
 * `cutoff`より前の終端状態のwork itemを削除し、件数と削除した行の参照を返す。
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
    await addNotice({
      kind: "cleanup_db_failed",
      message: `終端 work item の削除に失敗しました: ${message}`,
    });
    return { work_items_deleted: 0, approval_requests_deleted: 0, deleted: [] };
  }
}

/**
 * 削除したwork itemの要件定義ディレクトリを消し、消せた数を返す。
 * `wi-<id>`は中身ごと消し、親の`issue-<N>`は空になった場合だけ消す。
 * 同じIssueの別のwork itemが自分の`wi-<id>`を持っていることがあるため。
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
      await addNotice({
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
    await addNotice({
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
    await addNotice({
      kind: "cleanup_db_failed",
      message: `デプロイ記録の削除に失敗しました: ${message}`,
    });
    return 0;
  }
}

async function cleanupNotices(cutoff: Date, log: Logger): Promise<number> {
  try {
    return await deleteResolvedNoticesBefore(cutoff);
  } catch (err) {
    const message = errorMessage(err);
    log.error("cleanup_db: failed to delete resolved notices", {
      error: message,
    });
    await addNotice({
      kind: "cleanup_db_failed",
      message: `通知の削除に失敗しました: ${message}`,
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
    await addNotice({
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

  const counts: CleanupCounts = {
    work_items_deleted: workItems.work_items_deleted,
    approval_requests_deleted: workItems.approval_requests_deleted,
    job_failures_deleted: jobFailuresDeleted,
    deployments_deleted: deploymentsDeleted,
    notices_deleted: noticesDeleted,
    doc_dirs_deleted: docDirsDeleted,
  };

  await recordRun(counts, log);
  log.info(summarizeCleanup(counts), counts);
  return counts;
}
