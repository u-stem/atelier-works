// Table-of-contents extraction for RequirementsDocument.tsx's right-hand
// sidebar: pulls every `##`/`###` heading out of a requirements document's
// markdown and derives the same `id` react-markdown's `h2`/`h3` renderer
// (components/Markdown.tsx) assigns, so a TOC entry's link (`#<id>`) always
// matches the heading it points at.

export type Heading = {
  readonly level: 2 | 3;
  readonly text: string;
  readonly id: string;
};

const HEADING_LINE_PATTERN = /^(##|###)\s+(.+?)\s*$/;

/** Derives a stable slug from a heading's text (pure, for testing) — kept
 * simple (lowercase, non-alphanumeric runs collapsed to `-`) rather than
 * pulling in a slug library, matching what `Markdown.tsx`'s heading
 * renderer computes for the same text so TOC links resolve. Non-ASCII text
 * (this document is Japanese) keeps its characters as-is; only ASCII
 * uppercase and separator characters are normalized. */
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

/** Extracts the document's `# ` title line (pure, for testing) — `null`
 * when the markdown has no level-1 heading. Used by
 * components/RequirementsDocument.tsx as the document's page title,
 * falling back to the work item's Issue title when absent. */
export function extractTitle(markdown: string): string | null {
  const match = TITLE_LINE_PATTERN.exec(markdown);
  return match?.[1] ?? null;
}

/** Extracts every `##`/`###` heading from `markdown`, in document order
 * (pure, for testing). A duplicate slug gets a `-2`, `-3`, ... suffix so
 * every `id` in the result is unique (two headings with the same text would
 * otherwise collide on the same anchor). */
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
