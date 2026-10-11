// 要件定義書のMarkdownから見出しを取り出し、目次と見出しの`id`に使う。
// 見出しの`id`は、ここで文書の行ごとに決める。描画側は、見出しの行番号から`id`を引くだけにする。
// こうすると、目次のリンクと見出しの`id`が必ず一致し、同じ文字の見出しが重なっても衝突しない。

/** 見出しの`id`の接頭辞。ページの他の要素の`id`や`name`と衝突しないようにする。 */
export const HEADING_ID_PREFIX = "h-";

export type Heading = {
  readonly level: 2 | 3;
  /** 目次に出す文字。強調などの記号は除く。 */
  readonly text: string;
  readonly id: string;
  /** Markdown上の見出しの行(1から数える)。 */
  readonly line: number;
};

/**
 * 見出しの文字列から、同じ入力なら常に同じになるスラッグを作る。
 * 小文字にし、空白と`/`を`-`に置き換え、文字・数字・`・`・`-`以外を除く。
 * 文書は日本語なので、ASCII以外の文字はそのまま残す。
 * 本文のリンクの`#<slug>`の判定(`markdownLink.ts`)も、この関数と同じ形を求める。
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

const HEADING_LINE = /^(#{1,3})[ \t]+(.+?)[ \t]*$/;
const CLOSING_HASHES = /[ \t]+#+$/;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

/** 見出しの行の文字から、リンクと強調の記号を除いた平文にする。 */
function plainHeadingText(raw: string): string {
  return raw
    .replace(CLOSING_HASHES, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*]|~~/g, "")
    .trim();
}

type RawHeading = {
  readonly level: 1 | 2 | 3;
  readonly text: string;
  readonly line: number;
};

/**
 * コードの囲みの外にある、`#`から`###`までの見出しの行を、文書の順に返す。
 * 囲みは行頭の```か~~~で始まり、同じ種類で同じ長さ以上の行で終わる。
 */
function scanHeadings(markdown: string): RawHeading[] {
  const found: RawHeading[] = [];
  let fence: { char: string; length: number } | null = null;
  const lines = markdown.split(/\r?\n/);
  lines.forEach((line, index) => {
    const marker = FENCE_LINE.exec(line)?.[1];
    if (marker !== undefined) {
      const char = marker.charAt(0);
      if (fence === null) {
        fence = { char, length: marker.length };
        return;
      }
      if (fence.char === char && marker.length >= fence.length) {
        fence = null;
      }
      return;
    }
    if (fence !== null) {
      return;
    }
    const match = HEADING_LINE.exec(line);
    const hashes = match?.[1];
    const text = match?.[2];
    if (hashes === undefined || text === undefined) {
      return;
    }
    const level = hashes.length;
    if (level === 1 || level === 2 || level === 3) {
      found.push({ level, text: plainHeadingText(text), line: index + 1 });
    }
  });
  return found;
}

export type Title = {
  readonly text: string;
  /** Markdown上のタイトルの行(1から数える)。 */
  readonly line: number;
};

/**
 * 文書の`# `で始まる最初の行をタイトルとして返す。無いか、文字が残らないときは`null`を返す。
 * 呼び出し側は、無いときに作業項目のIssueの題名で代える。
 */
export function findTitle(markdown: string): Title | null {
  const title = scanHeadings(markdown).find((heading) => heading.level === 1);
  return title === undefined || title.text === ""
    ? null
    : { text: title.text, line: title.line };
}

/** `findTitle`の文字だけを返す。 */
export function extractTitle(markdown: string): string | null {
  return findTitle(markdown)?.text ?? null;
}

/**
 * `##`と`###`の見出しをすべて、文書の順に返す。
 * 同じスラッグが重なったときは、2つ目から`-2`、`-3`…を付け、`id`を一意にする。
 * 文字が残らない見出しは、`id`を作れないので含めない。
 */
export function extractHeadings(markdown: string): Heading[] {
  const seen = new Map<string, number>();
  const headings: Heading[] = [];
  for (const heading of scanHeadings(markdown)) {
    if (heading.level === 1) {
      continue;
    }
    const slug = slugify(heading.text);
    if (slug === "") {
      continue;
    }
    const count = (seen.get(slug) ?? 0) + 1;
    seen.set(slug, count);
    const suffix = count === 1 ? "" : `-${String(count)}`;
    headings.push({
      level: heading.level,
      text: heading.text,
      id: `${HEADING_ID_PREFIX}${slug}${suffix}`,
      line: heading.line,
    });
  }
  return headings;
}

/** 見出しの行から`id`を引く。その行に見出しが無いか、行が分からないときは`null`を返す。 */
export function headingIdAtLine(
  headings: readonly Heading[],
  line: number | undefined,
): string | null {
  if (line === undefined) {
    return null;
  }
  return headings.find((heading) => heading.line === line)?.id ?? null;
}
