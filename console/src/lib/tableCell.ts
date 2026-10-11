// 要件定義書の表のセルを、折り返してよいかどうかで分ける。

const ID_TEXT = /^[A-Za-z]+(?:-[A-Za-z0-9]+)*-\d+$/;

/**
 * セルの文字が、`FR-001`のような単一のIDかどうかを返す。
 * IDはハイフンの位置で折り返されると読めなくなるので、描画側が折り返しを止める目印に使う。
 */
export function isIdCellText(text: string): boolean {
  return ID_TEXT.test(text.trim());
}
