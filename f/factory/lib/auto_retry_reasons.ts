// 自動で再開してよい止まった理由の一覧。
// 回復の待ち時間の判定(`pr_ci_fix_recovery.ts`)と、自動の再開(`auto_retry.ts`)が共有する。
// DBやWindmillのクライアントを持つモジュールへ依存を広げないよう、定数だけを切り出している。

import {
  CHECK_IMAGE_STALE_REASON,
  CHECK_RUNTIME_UNSAFE_REASON,
} from "./check_sandbox.ts";

/**
 * GitHubの一時的な失敗(5xxと通信断)で止まったPRレビューの、失敗の文の先頭。
 * 付けるのはPRレビューの準備と投稿のステップで、`pr_review_retry.ts`の再開と、失敗の通知の判定が読む。
 * 待っても結果が変わらない失敗には付けず、自動の再開に回さない。
 */
export const TRANSIENT_GITHUB_REASON_PREFIX = "github_transient: ";

/** イメージが古くて止まった理由の先頭。 */
export const CHECK_IMAGE_STALE_PREFIX = `${CHECK_IMAGE_STALE_REASON}: `;

/**
 * 稼働中のworkerが検査の前提を満たさず止まった理由の先頭。
 * 誰でも書き込めるパスの列挙に失敗した一時的な場合も、同じ先頭で始まる。
 * 自動の再開の対象ではなく、CI回の行を戻すまでの待ち(`pr_ci_fix_recovery.ts`)と、回数の数え方(`countPrCiFixRounds`)が読む。
 */
export const CHECK_RUNTIME_UNSAFE_PREFIX = `${CHECK_RUNTIME_UNSAFE_REASON}: `;

/** 自動で再開してよい止まった理由の先頭。 */
export const AUTO_RETRY_REASON_PREFIXES: readonly string[] = [
  CHECK_IMAGE_STALE_PREFIX,
];
