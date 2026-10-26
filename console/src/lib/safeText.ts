// サーバーが返す表示用の文字列を、画面に出せる形にする入口。
// ジョブの画面と設定の画面は、サーバー由来の文字列を、この関数を通してから描く。
// 通さずに描くと、見えない文字や並びを入れ替える文字が画面に残る。
// 置き換える文字の範囲は、このファイルが自分で持つ。保護パスの外のファイルに頼ると、
// 範囲を狭める変更が人のレビューを経ずに入るためである。
// 描画の部品がこの関数を通すことは、`tests/scripts/console_jobs_render_contract.test.ts`が確かめる。

/**
 * 画面に出さずに代替文字へ置き換える文字。
 * 書式の制御文字(Cf。双方向の制御文字、ゼロ幅の文字、tag文字を含む)、制御文字(Cc。C0、DEL、C1。ESCを含む。改行とタブを除く)、
 * 行と段落の区切り(Zl、Zp)、異体字セレクタ。
 * これらは見えないか、並びの見た目を入れ替える。
 */
const HIDDEN_CHARACTERS =
  /\p{Cf}|\p{Cc}|\p{Zl}|\p{Zp}|\p{Variation_Selector}/gu;

/**
 * 見えない文字と、並びを入れ替える文字、ANSIの開始の文字(ESC)を、代替文字(U+FFFD)にする。
 * 改行コードは`\n`に揃え、改行とタブは残す。
 * 文字列のノードとして描く前提で、HTMLやMarkdownの解釈はしない。
 */
export function safeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(HIDDEN_CHARACTERS, (char) =>
      char === "\n" || char === "\t" ? char : "�",
    );
}
