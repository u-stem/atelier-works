// 自動で再開してよい止まった理由の一覧と、再開の候補を選ぶ定数。
// 回復の待ち時間の判定(`pr_ci_fix_recovery.ts`)と、自動の再開(`auto_retry.ts`)が共有する。
// DBやWindmillのクライアントを持つモジュールへ依存を広げないよう、定数だけを切り出している。
// ファイルやサブプロセスを使う`check_sandbox.ts`と`host_action.ts`は読まない。
// 読むと、PRレビューの自動の再開のような、ファイルを使わないscriptまで、それらをimportでたどる。

import { CHECK_IMAGE_STALE_REASON } from "./check_sandbox_reasons.ts";

/** ホスト側の作業が要ることを示すnoticeの種類。 */
export const HOST_ACTION_NOTICE_KIND = "host_action_required";

/** 自動で解決したnoticeの`resolved_by`。 */
export const HOST_ACTION_RESOLVER = "self_update";

/**
 * イメージが古いことを知らせるnoticeの本文に含める句。
 * 自動の再開(`auto_retry.ts`)が、解決されたnoticeのうち、反映の通知と見分けるために読む。
 */
export const STALE_IMAGE_NOTICE_MARKER = "workerのイメージが古く";

/**
 * GitHubの一時的な失敗(5xxと通信断)で止まったPRレビューの、失敗の文の先頭。
 * 付けるのはPRレビューの準備と投稿のステップで、`pr_review_retry.ts`の再開と、失敗の通知の判定が読む。
 * 待っても結果が変わらない失敗には付けず、自動の再開に回さない。
 */
export const TRANSIENT_GITHUB_REASON_PREFIX = "github_transient: ";

/**
 * 実装の準備が、ブランチのPRで終端でないpr_fix / pr_reviewを見つけて止めた理由。
 * 実装の支援(`implement_support.ts`)も同じ値をexportする。
 */
export const ACTIVE_PR_RUN_REASON = "pull request has an active fix run";

/**
 * 終端でない回が終わるまで待って再開する止まった理由の先頭。
 * 通知の解決は待たない。再開の条件は、ブランチのPRに終端でない回が無いことである(`auto_retry.ts`)。
 * 上の一覧(`AUTO_RETRY_REASON_PREFIXES`)とは分ける。上の一覧は、イメージが古い通知の解決を再開の条件にし、
 * 回復の待ち時間の判定もそれを読む。ここに足した理由が、それらの判定に混ざらないようにするためである。
 */
export const PR_RUN_WAIT_REASON_PREFIXES: readonly string[] = [
  ACTIVE_PR_RUN_REASON,
];

export const PR_RUN_WAIT_MAX_AGE_MS = 0;

/** 自動で再開してよい止まった理由の先頭。 */
export const AUTO_RETRY_REASON_PREFIXES: readonly string[] = [
  `${CHECK_IMAGE_STALE_REASON}: `,
];
