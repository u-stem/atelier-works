// 文章の中の`で囲んだ範囲を、コードの部分として切り出す。
// Markdownの解析はしない。囲み以外の文字は、記号も含めてそのまま残す。
// HTMLとして読む経路が無いので、信頼できない入力にも使える。

export type TextPart = {
  readonly text: string;
  /** バッククォートで囲まれていた部分なら`true`。囲みの記号は`text`に含めない。 */
  readonly code: boolean;
};

// 1行の中で閉じた囲みだけをコードとして扱う。閉じていない`はただの文字である。
// 複数のバッククォートによる囲み(``a``)は扱わない。記号の位置がずれることはあっても、文字は失われない。
const CODE_SPAN_PATTERN = /`([^`\n]+)`/;

/** 文章をコードの部分とそれ以外に分ける。結合すると、囲みの記号を除いた元の文章になる。 */
export function splitCodeSpans(text: string): TextPart[] {
  // 囲みの中身を捕まえるため、分割の結果は偶数番目が囲みの外、奇数番目が中身になる。
  return text
    .split(CODE_SPAN_PATTERN)
    .map((part, index) => ({ text: part, code: index % 2 === 1 }))
    .filter((part) => part.text !== "");
}
