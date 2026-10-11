// Issueや外部の入力に由来する文字列を、画面に出す前に通す関数。
// 見た目を偽る文字を落とす。リンクの安全は`safeUrl.ts`が受け持つ。

/**
 * 落とす文字。
 * - 制御文字(`\p{Cc}`)。改行(`\n`)とタブ(`\t`)は残すので、置き換えの関数で戻す
 * - 書字方向の制御文字。U+061C、U+200E、U+200F、U+202A-202E、U+2066-2069
 * - 幅の無い文字と、見えない書式文字。U+180E、U+200B、U+2060-2064、U+FEFF
 * - 非推奨の書式文字。U+206A-206F
 * - タグ文字。U+E0000-E007F
 * ZWJ(U+200D)とZWNJ(U+200C)は残す。絵文字の列やペルシア語、インド系の文字が崩れるためである。
 * バックエンドの`sanitizePullRequestTitle`が落とす書式文字を、すべて含む。
 */
const REMOVED_CHARS =
  /[\p{Cc}\u{61C}\u{180E}\u{200B}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2060}-\u{206F}\u{FEFF}\u{E0000}-\u{E007F}]/gu;

const LINE_SEPARATORS = /[\u{2028}\u{2029}]/gu;

/**
 * 表示してよい形にする。
 * 双方向制御文字は、文字の並びを入れ替えて、書かれていない文に見せられる。
 * ゼロ幅文字とタグ文字は、目に見えない内容を忍ばせられる。
 * 行と段落の区切り(U+2028、U+2029)は改行にする。
 * 空白の整理も、長さの切り詰めもしない。それは呼び出し側の表示の都合で決める。
 */
export function sanitizeDisplayText(text: string): string {
  return text
    .replace(LINE_SEPARATORS, "\n")
    .replace(REMOVED_CHARS, (char) =>
      char === "\n" || char === "\t" ? char : "",
    );
}
