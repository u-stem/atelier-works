// `cleanup_db.ts`(DBの保持期間による掃除)の判定と整形を行う純粋関数群。
// I/Oは持たない。DB呼び出し、設定の読み込み、工程ごとのエラー処理、
// `docDirsFor`が返すパスの実際の削除は`cleanup_db.ts`が行う。

import type { DeletedWorkItemRef } from "./db.ts";
import { assertGitHubName, type FactoryConfig } from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 各PRの最新の記録を、保持期間の何倍まで残すか。 */
const LATEST_RETENTION_FACTOR = 4;

export type RetentionCutoffs = {
  /**
   * `updated_at`がこの時刻以前の、終端状態のwork_itemsを削除する。
   * work_itemsを`ON DELETE CASCADE`で参照する表の行も一緒に消える。
   */
  readonly workItemsBefore: Date;
  /**
   * 自身の時刻列がこの時刻以前の、job_failures、deployments、
   * 解決済みのnoticesの行を、work_itemsとは独立に削除する。
   */
  readonly logsBefore: Date;
  /**
   * 各PRの最新の`pr_ci_checks`の行を削除する基準。保持期間(`retention_logs_days`)の4倍前の時刻。
   * 最新の行は、読み直しと今のheadの記録のために、ほかの行より長く残す。
   */
  readonly latestLogsBefore: Date;
};

/**
 * `cleanup_db.ts`が削除の基準にする3つの時刻を返す。
 * `now`から設定の保持日数(`retention_work_items_days`、`retention_logs_days`)を引いた時刻と、
 * `retention_logs_days`の4倍を引いた時刻(`latestLogsBefore`)である。
 */
export function computeRetentionCutoffs(
  now: Date,
  config: Pick<
    FactoryConfig,
    "retention_work_items_days" | "retention_logs_days"
  >,
): RetentionCutoffs {
  return {
    workItemsBefore: new Date(
      now.getTime() - config.retention_work_items_days * DAY_MS,
    ),
    logsBefore: new Date(now.getTime() - config.retention_logs_days * DAY_MS),
    latestLogsBefore: new Date(
      now.getTime() -
        config.retention_logs_days * LATEST_RETENTION_FACTOR * DAY_MS,
    ),
  };
}

/**
 * `cleanup_db.ts`の1回の実行で削除した件数。
 * `cleanup_runs`テーブルの列に対応する。
 * `id`と`ran_at`は`db.ts`の`insertCleanupRun`が埋めるため含まない。
 */
export type CleanupCounts = {
  readonly work_items_deleted: number;
  readonly approval_requests_deleted: number;
  readonly job_failures_deleted: number;
  readonly deployments_deleted: number;
  readonly notices_deleted: number;
  /** 保持期間を過ぎた「情報」の未解決の通知を、削除せず解決済みにした件数。 */
  readonly info_notices_resolved: number;
  /** 保持期間を過ぎた、判定済みのmainのCIの記録(`main_ci_runs`)の削除件数。判定を待つ行と、各リポジトリの最新の行は消さない。 */
  readonly main_ci_runs_deleted: number;
  /** 保持期間を過ぎた、workerの負荷の記録(`worker_samples`)の削除件数。期限を過ぎた行はすべて消す。 */
  readonly worker_samples_deleted: number;
  /** 保持期間を過ぎた、PRのCIの判定済みの記録(`pr_ci_checks`)の削除件数。判定を待つ行は消さない。各PRの最新の行は保持期間の4倍まで残す。 */
  readonly pr_ci_checks_deleted: number;
  /** 作業項目の削除に合わせて消した要件定義書のディレクトリ(`docDirsFor`)。 */
  readonly doc_dirs_deleted: number;
};

/**
 * `counts`を1行の日本語に要約する。
 * `cleanup_db.ts`のジョブログと、daily_summaryのDiscord embedの
 * 「DB 掃除」欄の両方で使う。
 * 表示する4件の削除はそれぞれ独立した掃除で、運用者が個別に気にしうるものに限る。
 * `approval_requests_deleted`はwork_items削除のカスケードによる副作用、
 * `doc_dirs_deleted`は同じ削除に伴うファイルシステム上の副作用で、
 * どちらも独立した掃除ではないため意図的に省く。
 * `main_ci_runs_deleted`、`worker_samples_deleted`、`pr_ci_checks_deleted`は、運用者が気にする対象ではない内部の記録の掃除なので省く。
 */
export function summarizeCleanup(counts: CleanupCounts): string {
  const deleted =
    `work item ${String(counts.work_items_deleted)}件、` +
    `失敗記録${String(counts.job_failures_deleted)}件、` +
    `デプロイ記録${String(counts.deployments_deleted)}件、` +
    `通知${String(counts.notices_deleted)}件を削除しました`;
  return counts.info_notices_resolved > 0
    ? `${deleted}。古い情報の通知${String(counts.info_notices_resolved)}件を解決しました`
    : deleted;
}

// ---------------------------------------------------------------------------
// 要件定義書のディレクトリの掃除。ここではパスを計算するだけで、
// 実際の削除は`cleanup_db.ts`が`lib/workspace.ts`の`removePath` /
// `removeEmptyDir`でベストエフォートに行う。
// ---------------------------------------------------------------------------

export type DocDirsToDelete = {
  /**
   * 削除した作業項目の要件定義書のディレクトリ
   * (`<base>/<owner>/<repo>/issue-<N>/wi-<id>`)。
   * すべての試行を含むディレクトリで、再帰的に削除する。
   */
  readonly wiDir: string;
  /**
   * 親の`issue-<N>`ディレクトリ。
   * 同じIssueの別の作業項目の`wi-<id>`が残っていることがあるため、
   * `cleanup_db.ts`は空になった場合に限り消す。
   */
  readonly issueDir: string;
};

/**
 * 削除した作業項目(`db.ts`の`deleteTerminalWorkItemsBefore`の戻り値)ごとに、
 * 消すべき要件定義書のディレクトリを返す。
 * `issue_number`の無い作業項目は飛ばす
 * (`pr`種別の作業項目は要件定義書のディレクトリを持たない)。
 * パスは`lib/requirements_template.ts`の`buildRequirementsDocDir`と
 * `wi-<id>`の階層までそろえる。
 * すべての試行をまとめて消すため、`attempt-<k>`の階層までは下りない。
 * `owner`か`repo`がGitHubの名前として不正なら例外を投げる。
 */
export function docDirsFor(
  items: readonly DeletedWorkItemRef[],
  base: string,
): DocDirsToDelete[] {
  const result: DocDirsToDelete[] = [];
  for (const item of items) {
    if (item.issue_number === null) continue;
    assertGitHubName(item.owner);
    assertGitHubName(item.repo);
    const issueDir = `${base}/${item.owner}/${item.repo}/issue-${item.issue_number}`;
    result.push({ wiDir: `${issueDir}/wi-${item.id}`, issueDir });
  }
  return result;
}
