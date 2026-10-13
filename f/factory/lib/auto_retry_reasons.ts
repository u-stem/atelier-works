// 自動で再開してよい止まった理由の一覧。
// 回復の待ち時間の判定(`pr_ci_fix_recovery.ts`)と、自動の再開(`auto_retry.ts`)が共有する。
// DBやWindmillのクライアントを持つモジュールへ依存を広げないよう、定数だけを切り出している。

import { CHECK_IMAGE_STALE_REASON } from "./check_sandbox.ts";

/** 自動で再開してよい止まった理由の先頭。 */
export const AUTO_RETRY_REASON_PREFIXES: readonly string[] = [
  `${CHECK_IMAGE_STALE_REASON}: `,
];
