// 検査の前提を満たさないときの理由の先頭。
// 自動の再開の許可リスト(`auto_retry_reasons.ts`)が読む。
// 検査枠を操作する`check_sandbox.ts`から切り出しているのは、理由の文を読むだけのモジュールが、
// ファイルやサブプロセスのモジュールをimportでたどらないようにするためである。

/** イメージの前提を満たさないときの理由の先頭。運用者が取る操作(`mise run up`)を含める。 */
export const CHECK_IMAGE_STALE_REASON =
  "worker image is stale: run mise run up";
