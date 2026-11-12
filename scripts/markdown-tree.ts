// 文書の検査が共通で使う、Markdownの構文木の読み方。
// CommonMarkとGFM、先頭のfrontmatterを読む。
// `scripts/lint-doc-links.ts`、`scripts/lint-risk-register.ts`、`scripts/lint-one-sentence-per-line.ts`が使う。

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

/** パスの文書の構文木を返す。読めないパスは`undefined`。 */
export type ReadTree = (path: string) => Nodes | undefined;

/**
 * `read`が返す本文を構文木にする`ReadTree`を作る。
 * 文書ごとに、最初に尋ねられたときに1回だけ読んで解析し、以後は同じ木を返す。
 * 複数の検査が同じ木を共有して、同じ文書を解析し直さないため。
 * 木は共有するので、呼び出し側は書き換えない。
 */
export function createTreeReader(
  read: (path: string) => string | undefined,
): ReadTree {
  const trees = new Map<string, Nodes | undefined>();
  return (path) => {
    if (trees.has(path)) return trees.get(path);
    const markdown = read(path);
    const tree = markdown === undefined ? undefined : parseMarkdown(markdown);
    trees.set(path, tree);
    return tree;
  };
}

/** 子を持つ節をたどり、文書の順に`onNode`を呼ぶ。親を子より先に呼ぶ。 */
export function visit(node: Nodes, onNode: (node: Nodes) => void): void {
  onNode(node);
  if ("children" in node) {
    for (const child of node.children) visit(child, onNode);
  }
}
