// 要件定義書のMarkdownに現れるリンクを、リンクにしてよいか判定する。
// 本文は信頼できないIssueの内容を要約したもので、`rehype-sanitize`の既定は
// `https`と`http`の任意のURLを通す。管理者のWindmillと同じオリジンで描くため、
// 読み手がリンクの行き先を取り違えて外のページを開かないよう、
// 行き先を、作業項目と同じリポジトリのIssueとPRのURLと、同じページの見出しだけに絞る。

import { HEADING_ID_PREFIX, slugify } from "./markdownHeadings.ts";
import { safeGitHubUrl } from "./safeUrl.ts";

/** 注記に出すURLの最大の長さ。長い`data:`のURLで表示が崩れないようにする。 */
const MAX_NOTE_LENGTH = 200;

/** リンクにしてよいGitHubのリポジトリ。作業項目のownerとrepoである。 */
export type RepoRef = {
  readonly owner: string;
  readonly repo: string;
};

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
 * 脚注への参照が使う`id`の接頭辞。無害化が脚注の`id`に付ける。
 * 本文は脚注の記法を使わない方針で、この`id`の要素は描かれない。
 * 見出しへのリンクと同じ形に見えるので、読み替えずに文字にする。
 */
const FOOTNOTE_ID_PREFIX = "user-content-fn";

/**
 * `#`で始まり、`slugify`が作る見出しのスラッグと同じ形のときだけ、
 * `#`を除いたスラッグを返す。そうでなければ`null`を返す。
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
  if (
    decoded === "" ||
    slugify(decoded) !== decoded ||
    decoded.startsWith(FOOTNOTE_ID_PREFIX)
  ) {
    return null;
  }
  return decoded;
}

/**
 * `safeGitHubUrl`を通ったURLが、`repo`のIssueかPRを指すかを返す。
 * GitHubはownerとrepoの大文字小文字を区別しないので、区別せずに比べる。
 */
function isUrlOfRepo(githubUrl: string, repo: RepoRef): boolean {
  const [, , , owner, name] = githubUrl.split("/");
  return (
    owner?.toLowerCase() === repo.owner.toLowerCase() &&
    name?.toLowerCase() === repo.repo.toLowerCase()
  );
}

/**
 * Markdownのリンク1つについて、リンクにするか文字で出すかを決める。
 * リンクにするのは、`safeGitHubUrl`を通り、かつ`repo`のものであるURLと、見出しのスラッグの形の
 * 同じページのフラグメントだけである。それ以外は文字で出す。
 * 見出しへのリンクは、描画側が見出しに付ける`id`(接頭辞つき)に読み替える。
 * 別のリポジトリのURLをリンクにすると、信頼できない本文が、読み手を別の
 * リポジトリへ誘導できるため、`repo`が`null`の呼び出し元では、GitHubのURLも文字で出す。
 * `label`はリンクの表示文字(平文)。URLと違うときは`note`にURLを入れ、
 * 読み手が行き先を判断できるように、呼び出し側が添えて表示する。
 * 同じページの見出しへのリンクは、行き先を取り違えようがないので`note`を付けない。
 */
export function resolveMarkdownLink(
  href: string | undefined,
  label: string,
  repo: RepoRef | null,
): MarkdownLink {
  if (href === undefined) {
    return { kind: "text", note: null };
  }
  const note = label.trim() === href ? null : shorten(href);

  const slug = headingSlugOf(href);
  if (slug !== null) {
    return {
      kind: "link",
      href: `#${HEADING_ID_PREFIX}${slug}`,
      external: false,
      note: null,
    };
  }

  const githubUrl = safeGitHubUrl(href);
  if (githubUrl !== null && repo !== null && isUrlOfRepo(githubUrl, repo)) {
    return { kind: "link", href: githubUrl, external: true, note };
  }

  return { kind: "text", note: href === "" ? null : note };
}
