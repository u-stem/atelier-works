// サーバーが返す表示用の文字列を、画面に出せる形にする入口。
// ジョブの画面と設定の画面は、サーバー由来の文字列を、この関数を通してから描く。
// 通さずに描くと、見えない文字や並びを入れ替える文字が画面に残る。
// 描画の部品がこの関数を通すことは、`tests/scripts/console_jobs_render_contract.test.ts`が確かめる。

import { displayableIssueText } from "./intakeText.ts";

/**
 * 見えない文字と、並びを入れ替える文字、ANSIの開始の文字を、代替文字にする。
 * 文字列のノードとして描く前提で、HTMLやMarkdownの解釈はしない。
 */
export function safeText(text: string): string {
  return displayableIssueText(text).text;
}
