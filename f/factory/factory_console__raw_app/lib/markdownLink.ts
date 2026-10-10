// 要件定義書と監査レポートのMarkdownに現れるリンクを、リンクにしてよいか判定する。
// 本文は信頼できないIssueの内容を要約したもので、`rehype-sanitize`の既定は
// `https`と`http`の任意のURLを通す。管理者のWindmillと同じオリジンで描くため、
// 読み手がリンクの行き先を取り違えて外のページを開かないよう、
// 行き先をGitHubのIssueとPRのURLと、同じページの見出しだけに絞る。

import { slugify } from "./extractHeadings";
import { safeGitHubUrl } from "./githubLink";

/** 注記に出すURLの最大の長さ。長い`data:`のURLで表示が崩れないようにする。 */
const MAX_NOTE_LENGTH = 200;

export type MarkdownLink =
  | {
      readonly kind: "link";
      readonly href: string;
      /** 別のページへ移るリンクか(同じページの見出しへのリンクは`false`)。 */
      readonly external: boolean;
      /** リンクの文字と違うときに、読み手に見せるURL。見せなくてよいときは`null`。 */
      readonly note: string | null;
    }
  | {
      readonly kind: "text";
      readonly note: string | null;
    };

function shorten(text: string): string {
  return text.length > MAX_NOTE_LENGTH
    ? `${text.slice(0, MAX_NOTE_LENGTH)}…`
    : text;
}

/**
 * `#`で始まり、`slugify`が作る見出しのslugと同じ形のときだけ、
 * `#`を除いたslugを返す。そうでなければ`null`を返す。
 * Markdownの処理系は`href`の非ASCIIをパーセントエンコードするので、
 * 先に復号する。復号に失敗する値は拒否する。
 */
function headingSlugOf(href: string): string | null {
  if (!href.startsWith("#")) {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.slice(1));
  } catch {
    return null;
  }
  if (decoded === "" || slugify(decoded) !== decoded) {
    return null;
  }
  return decoded;
}

/**
 * Markdownのリンク1つについて、リンクにするか文字で出すかを決める。
 * リンクにするのは、`safeGitHubUrl`を通るURLと、見出しのslugの形の
 * 同じページのフラグメントだけである。それ以外は文字で出す。
 * `label`はリンクの表示文字(平文)。URLと違うときは`note`にURLを入れ、
 * 読み手が行き先を判断できるように、呼び出し側が添えて表示する。
 * 同じページの見出しへのリンクは、行き先を取り違えようがないので`note`を付けない。
 */
export function resolveMarkdownLink(
  href: string | undefined,
  label: string,
): MarkdownLink {
  if (href === undefined) {
    return { kind: "text", note: null };
  }
  const note = label.trim() === href ? null : shorten(href);

  const slug = headingSlugOf(href);
  if (slug !== null) {
    return { kind: "link", href: `#${slug}`, external: false, note: null };
  }

  const githubUrl = safeGitHubUrl(href);
  if (githubUrl !== null) {
    return { kind: "link", href: githubUrl, external: true, note };
  }

  return { kind: "text", note: href === "" ? null : note };
}
