// 監査レポートのMarkdownを描くときの判定。
// 本文は監査のClaudeが、信頼できない運用記録から書いた文章である。
// 管理者のWindmillと同じオリジンで描くので、リンクは1つも張らず、行き先は文字で見せる。
// 監査レポートの本文にはURLを書かない決まりで、リポジトリの情報も渡されないため、
// 張ってよいリンクが無い。

/** 注記に出すURLの最大の長さ。長いURLで表示が崩れないようにする。 */
const MAX_NOTE_LENGTH = 200;

/**
 * リンクの文字と違うときに、読み手に見せる行き先。見せなくてよいときは`null`。
 * 読み手が行き先を取り違えないよう、文字で出す。
 * `#`で始まる行き先(脚注の内部アンカー)は、行き先を取り違えようがないので見せない。
 */
export function linkNote(
  href: string | undefined,
  label: string,
): string | null {
  if (
    href === undefined ||
    href === "" ||
    href.startsWith("#") ||
    label.trim() === href
  ) {
    return null;
  }
  return href.length > MAX_NOTE_LENGTH
    ? `${href.slice(0, MAX_NOTE_LENGTH)}…`
    : href;
}
