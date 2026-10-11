// Issueの題名と本文を画面に出す前に通す整形。
// 起票者が書いた文字列なので、見た目に現れない文字と、並びの見た目を入れ替える文字を、そのまま描かない。

/**
 * 画面に出さずに代替文字へ置き換える文字。
 * 書式の制御文字(Unicodeの分類Cf。双方向の制御文字、ゼロ幅の文字、tag文字などを含む)、
 * 制御文字(Cc。改行とタブを除く)、行と段落の区切り(Zl、Zp)、異体字セレクタ(Variation_Selector)。
 * これらは承認者には見えないか、並びの見た目を入れ替えるが、実装のClaudeには届く。
 */
const HIDDEN_CHARACTERS =
  /\p{Cf}|\p{Cc}|\p{Zl}|\p{Zp}|\p{Variation_Selector}/gu;

export type DisplayableText = {
  readonly text: string;
  /** 置き換えた文字が1つでもあったか。 */
  readonly replaced: boolean;
};

/**
 * `text`を画面に出せる形にする。改行コードを`\n`に揃え、
 * 見えない文字や見た目をずらす文字(改行とタブを除く)を代替文字(U+FFFD)に置き換える。
 * ゼロ幅接合子(U+200D)も置き換えるので、絵文字の組み合わせは分かれて見える。
 * 内容は解釈しない。HTMLやMarkdownとしては描かず、呼び出し側はReactの文字列として出す。
 */
export function displayableIssueText(text: string): DisplayableText {
  let replaced = false;
  const result = text
    .replace(/\r\n?/g, "\n")
    .replace(HIDDEN_CHARACTERS, (char) => {
      if (char === "\n" || char === "\t") return char;
      replaced = true;
      return "\uFFFD";
    });
  return { text: result, replaced };
}
