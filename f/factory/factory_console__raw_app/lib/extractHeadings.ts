// 要件定義書のMarkdownから見出しを取り出す。
// `RequirementsDocument.tsx`の右側の目次に使う。
// `components/Markdown.tsx`が`h2`/`h3`に付ける`id`と同じ値を作るので、
// 目次のリンク(`#<id>`)は、指す先の見出しと必ず一致する。

export type Heading = {
  readonly level: 2 | 3;
  readonly text: string;
  readonly id: string;
};

const HEADING_LINE_PATTERN = /^(##|###)\s+(.+?)\s*$/;

/**
 * 見出しの文字列から、同じ入力なら常に同じになるスラッグを作って返す。
 * 小文字にし、空白と`/`を`-`に置き換え、文字・数字・`・`・`-`以外を除く。
 * 文書は日本語なので、ASCII以外の文字はそのまま残す。
 * `Markdown.tsx`の見出しも同じ関数で`id`を作るため、目次のリンクが見出しに届く。
 * スラッグ用のライブラリは使わず、この単純な規則にとどめる。
 */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s/]+/g, "-")
    .replace(/[^\p{L}\p{N}・-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

const TITLE_LINE_PATTERN = /^#\s+(.+?)\s*$/m;

/**
 * 文書の`# `で始まるタイトル行を取り出す。レベル1の見出しが無ければ`null`を返す。
 * `components/RequirementsDocument.tsx`がページのタイトルに使い、
 * `null`のときは作業項目のIssueのタイトルで代える。
 */
export function extractTitle(markdown: string): string | null {
  const match = TITLE_LINE_PATTERN.exec(markdown);
  return match?.[1] ?? null;
}

/**
 * `markdown`から`##`/`###`の見出しをすべて、文書の順に取り出す。
 * 同じ文字列の見出しが同じアンカーで衝突しないよう、重複したスラッグには
 * `-2`、`-3`…を付け、結果の`id`をすべて一意にする。
 */
export function extractHeadings(markdown: string): Heading[] {
  const seen = new Map<string, number>();
  const headings: Heading[] = [];
  for (const line of markdown.split("\n")) {
    const match = HEADING_LINE_PATTERN.exec(line);
    if (match === null) {
      continue;
    }
    const marker = match[1];
    const text = match[2];
    if (marker === undefined || text === undefined) {
      continue;
    }
    const level = marker === "##" ? 2 : 3;
    const baseSlug = slugify(text);
    const count = seen.get(baseSlug) ?? 0;
    seen.set(baseSlug, count + 1);
    const id = count === 0 ? baseSlug : `${baseSlug}-${String(count + 1)}`;
    headings.push({ level, text, id });
  }
  return headings;
}
