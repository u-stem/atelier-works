// flowの図を、幅に合わせてどう見せるかを決める純関数と、図の中の文字列の折り返し。

/** 図が読める最小の幅(px)。これより狭いときは図の代わりに一覧を出す。 */
export const FIT_MIN_WIDTH = 640;

/** 図を包むカードが、左右に取る幅(px)。枠の1pxと余白の8pxを、両側で足した値。 */
export const FIT_CHROME_WIDTH = 18;

export type GraphPresentation = "fit" | "scroll" | "list";

/**
 * 節の実際の幅から、図の見せ方を決める。
 * 図を包むカードの分を引いた幅に、配置の幅が収まるなら図をそのまま出す。
 * 収まらず最小の幅以上なら横にスクロールする枠、最小の幅より狭いなら一覧にする。
 * カードの分を引くのは、節の幅と図の幅が同じとき、図がカードからはみ出すためである。
 * 幅が測れていない(0以下)間は、枠に入れて描く。測れた後に見せ方が変わるだけで済み、図が隠れない。
 */
export function graphPresentation(
  width: number,
  extentWidth: number,
): GraphPresentation {
  if (width <= 0) return "scroll";
  if (width < FIT_MIN_WIDTH) return "list";
  return width - FIT_CHROME_WIDTH >= extentWidth ? "fit" : "scroll";
}

/** 半角の文字の幅(em)。全角の文字は1emとして数える。 */
const NARROW_EM = 0.55;
const ELLIPSIS = "…";

function emOf(character: string): number {
  return character.charCodeAt(0) < 0x100 ? NARROW_EM : 1;
}

function emOfText(characters: readonly string[]): number {
  return characters.reduce((sum, character) => sum + emOf(character), 0);
}

/**
 * 箱の幅(em)に収まるように、文字列を行に分ける。
 * 文字の幅は、半角を0.55em、それ以外を1emとして見積もる。フォントの実測ではない。
 * `maxLines`を超える分は切り、最後の行の末尾を「…」にする。
 */
export function wrapLines(
  text: string,
  maxEm: number,
  maxLines: number,
): string[] {
  const lines: string[][] = [];
  let current: string[] = [];
  let truncated = false;
  for (const character of Array.from(text)) {
    if (emOfText(current) + emOf(character) > maxEm && current.length > 0) {
      if (lines.length + 1 >= maxLines) {
        truncated = true;
        break;
      }
      lines.push(current);
      current = [];
    }
    current.push(character);
  }
  if (current.length > 0) lines.push(current);
  const last = lines[lines.length - 1];
  if (truncated && last !== undefined) {
    while (last.length > 0 && emOfText(last) + 1 > maxEm) last.pop();
    last.push(ELLIPSIS);
  }
  return lines.map((line) => line.join(""));
}
