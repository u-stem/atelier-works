// 起動関係の図を、節の幅に合わせてどう見せるかを決める純関数。

/** 図が読める最小の幅(px)。これより狭いときは図の代わりに一覧を出す。 */
export const FIT_MIN_WIDTH = 640;

export type GraphPresentation = "fit" | "scroll" | "list";

export function graphPresentation(
  _width: number,
  _extentWidth: number,
): GraphPresentation {
  return "list";
}

/** 箱の幅(em)に収まるように、文字列を行に分ける。 */
export function wrapLines(
  _text: string,
  _maxEm: number,
  _maxLines: number,
): string[] {
  return [];
}
