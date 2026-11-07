// 全停止の確認のダイアログが使う、理由の検査と、効果の説明の文。
// 理由の上限はscriptと同じ200で、画面はUTF-16の長さで数える(scriptのコードポイントの数え方より厳しい)。
// Consoleはf/を読み込めないので、scriptの検査を写して持つ。写しが食い違わないことは`tests/lib/stop_all.test.ts`が確かめる。

export const STOP_ALL_REASON_MAX_LENGTH = 200;

export type StopAllReasonProblem =
  | "reason_empty"
  | "reason_too_long"
  | "reason_has_control";

/** 改行、制御文字、表示の並びを偽装できる書式文字。scriptも同じ文字を断る。 */
const CONTROL_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** 理由の問題を返す。使えるなら`null`を返す。 */
export function checkStopAllReason(
  reason: string,
): StopAllReasonProblem | null {
  if (reason.trim() === "") return "reason_empty";
  if (reason.length > STOP_ALL_REASON_MAX_LENGTH) return "reason_too_long";
  if (CONTROL_CHARS.test(reason)) return "reason_has_control";
  return null;
}

export function stopAllReasonMessage(problem: StopAllReasonProblem): string {
  switch (problem) {
    case "reason_empty":
      return "理由を書いてください。";
    case "reason_too_long":
      return `理由は${String(STOP_ALL_REASON_MAX_LENGTH)}文字までです。`;
    case "reason_has_control":
      return "理由に改行や制御文字は使えません。";
  }
}

/** 全停止の確認で並べる効果。 */
export const STOP_ALL_EFFECT_LINES: readonly string[] = [
  "factory_configのtrueの*_enabledを、すべてfalseにします。",
  "見張りと片付けの4本を除く、リポジトリのスケジュールを無効にします。自己更新も止まります。",
  "実行中のClaudeと検査は、15秒以内に自分で止まります。ジョブは中止しません。",
  "止めた*_enabledの名前を記録します。解除しても*_enabledは戻りません。修正の反映を確かめてから、ホストの端末でmise run stop:restoreを実行して戻します。",
  "残ったプロセスは、ホストでmise run stop -- --kill-onlyを実行して止めます。",
];

/** 解除の確認で並べる効果。 */
export const STOP_ALL_RELEASE_LINES: readonly string[] = [
  "全停止の変数を空に戻し、リポジトリのスケジュールを有効に戻します。凍結のあるスケジュールは戻しません。",
  "factory_configの*_enabledは止めたままなので、機能は動き出しません。修正の反映を確かめてから、ホストの端末でmise run stop:restoreを実行して戻します。",
];
