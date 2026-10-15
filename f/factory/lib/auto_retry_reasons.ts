// 自動で再開してよい止まった理由の一覧。
// 回復の待ち時間の判定(`pr_ci_fix_recovery.ts`)と、自動の再開(`auto_retry.ts`)が共有する。
// DBやWindmillのクライアントを持つモジュールへ依存を広げないよう、定数だけを切り出している。

import { CHECK_IMAGE_STALE_REASON } from "./check_sandbox.ts";

/**
 * GitHubの一時的な失敗(5xxと通信断)で止まったPRレビューの、失敗の文の先頭。
 * 付けるのは投稿のステップで、`pr_review_retry.ts`の再開と、失敗の通知の判定が読む。
 * 待っても結果が変わらない失敗には付けず、自動の再開に回さない。
 */
export const TRANSIENT_GITHUB_REASON_PREFIX = "github_transient: ";

/** 自動で再開してよい止まった理由の先頭。 */
export const AUTO_RETRY_REASON_PREFIXES: readonly string[] = [
  `${CHECK_IMAGE_STALE_REASON}: `,
];
