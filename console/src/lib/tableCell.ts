// 要件定義書の表のセルの文字から、折り返してはいけないIDを取り出す。

export type TextPiece = {
  readonly text: string;
  /** `FR-001`のようなIDのときは真。 */
  readonly id: boolean;
};

// IDは大文字の接頭辞で始まる。前後が英数字かハイフンの並びは、IDの一部とみなさない。
// 小文字を含む長い語(`Cross-Site-Request-Forgery-2024`など)は包まない。
const ID_TOKEN = /(?<![A-Za-z0-9-])[A-Z]+(?:-[A-Z0-9]+)*-\d+(?![A-Za-z0-9-])/g;

/**
 * 文字を、IDとそれ以外の断片に分けて、元の順に返す。
 * IDはハイフンの位置で折り返されると読めなくなるので、描画側がIDの断片だけ折り返しを止める。
 */
export function splitIdTokens(text: string): TextPiece[] {
  const pieces: TextPiece[] = [];
  let last = 0;
  for (const match of text.matchAll(ID_TOKEN)) {
    if (match.index > last) {
      pieces.push({ text: text.slice(last, match.index), id: false });
    }
    pieces.push({ text: match[0], id: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    pieces.push({ text: text.slice(last), id: false });
  }
  return pieces;
}
