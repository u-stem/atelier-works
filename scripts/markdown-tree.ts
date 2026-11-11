// 文書の検査が共通で使う、Markdownの構文木の読み方。
// CommonMarkとGFM、先頭のfrontmatterを読む。
// `scripts/lint-doc-links.ts`と`scripts/lint-one-sentence-per-line.ts`が使う。

import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { frontmatter } from "micromark-extension-frontmatter";
import { gfm } from "micromark-extension-gfm";

/** `markdown`を構文木にする。 */
export function parseMarkdown(markdown: string): Nodes {
  return fromMarkdown(markdown, {
    extensions: [gfm(), frontmatter()],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown()],
  });
}

/** 子を持つ節をたどり、文書の順に`onNode`を呼ぶ。親を子より先に呼ぶ。 */
export function visit(node: Nodes, onNode: (node: Nodes) => void): void {
  onNode(node);
  if ("children" in node) {
    for (const child of node.children) visit(child, onNode);
  }
}
