// `tabs/FailuresTab.tsx`の「再実行」ボタンを押した後に出す結果の文言を決める関数。
// Reactをマウントせずに単体テストできるよう分けている。
// 扱うのは`retryWorkItem(...)`が正常に返した結果(`RetryWorkItemResult`)だけである。
// 呼び出しが例外で失敗した場合は、`FailuresTab.tsx`の`handleRetry`が
// `lib/api.ts`の`describeError`で別のエラー表示にする。

import { isRecord } from "./coerce";

/**
 * `ok`が`false`のときは、フローは起動したが、別の実行がリースを持っていたため
 * 作業項目にジョブIDを記録しなかったことを伝える。
 * 単に「開始しました」と出すと、記録された実行が別にあることに気付けないため。
 * それ以外(`ok`が無い形も含む)は、例外にならずに返ったので開始したと伝える。
 */
export function describeRetry(result: unknown): string {
  if (isRecord(result) && result.ok === false) {
    return "再実行のフローを起動しましたが、別の実行がリースを持っているため、この作業項目には記録していません";
  }
  return "再実行を開始しました";
}
