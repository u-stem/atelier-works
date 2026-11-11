import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import GithubSlugger from "github-slugger";
import type { Nodes } from "mdast";
import * as mdastToString from "mdast-util-to-string";
import { parseMarkdown, visit } from "../../scripts/markdown-tree.ts";

// 残るリスクの表(docs/security-risks.md)と、各節からのIDのリンクを確かめる。

const REPO_ROOT = join(import.meta.dir, "../..");
const REGISTER = "docs/security-risks.md";
const ID_PATTERN = /^R-[A-Z]+-\d{2}$/;

// 表へのリンクを持たない「残るリスク」の箇条書きの数の上限。
// 確かめていない前提、後の作業、安全策の説明は表に載せず元の節に残すので、0にはならない。
// 表を通さない残るリスクを新しく増やさないために置き、表へ移したら下げる。
// 数え方は countUnregisteredRiskBullets にある。
const UNREGISTERED_RISK_BULLETS_LIMIT = 45;

// 一覧を導く文。この文の直後の箇条書きを、残るリスクの束として数える。
const RISK_INTRO =
  /残るリスク.*(次のとおり|次の[0-9０-９一二三四五六七八九十]+つ|次の回避|がある。)/;

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

function text(node: Nodes): string {
  return mdastToString.toString(node, {
    includeHtml: false,
    includeImageAlt: false,
  });
}

// 表の外で、IDのリンクを探す文書。docs/の下とREADMEである。
function documents(): string[] {
  const out = ["README.md"];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(REPO_ROOT, dir), {
      withFileTypes: true,
    })) {
      const path = posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".md") && path !== REGISTER) out.push(path);
    }
  };
  walk("docs");
  return out.sort();
}

type Entry = { id: string; anchor: string };

// 表の行のIDと、その行がある領域の見出しのアンカーを返す。
// 1列目の見出しが「ID」の表だけを読む。
function registerEntries(): Entry[] {
  const tree = parseMarkdown(read(REGISTER));
  const slugger = new GithubSlugger();
  const out: Entry[] = [];
  let anchor = "";
  if (!("children" in tree)) return out;
  for (const node of tree.children) {
    if (node.type === "heading") anchor = slugger.slug(text(node));
    if (node.type !== "table") continue;
    const [header, ...rows] = node.children;
    if (header === undefined || text(header.children[0] ?? header) !== "ID") {
      continue;
    }
    for (const row of rows) {
      const first = row.children[0];
      if (first !== undefined) out.push({ id: text(first).trim(), anchor });
    }
  }
  return out;
}

type RegisterLink = { file: string; label: string; anchor: string };

function resolvesToRegister(file: string, url: string): string | null {
  const [path, fragment] = url.split("#");
  if (path === undefined || path === "" || /^[a-z]+:/i.test(path)) return null;
  const target = posix.normalize(posix.join(posix.dirname(file), path));
  if (target !== REGISTER) return null;
  return fragment === undefined ? "" : decodeURIComponent(fragment);
}

// 表の外から表へ向かうリンクを返す。
function registerLinks(): RegisterLink[] {
  const out: RegisterLink[] = [];
  for (const file of documents()) {
    visit(parseMarkdown(read(file)), (node) => {
      if (node.type !== "link") return;
      const anchor = resolvesToRegister(file, node.url);
      if (anchor !== null) out.push({ file, label: text(node), anchor });
    });
  }
  return out;
}

function linksToRegister(node: Nodes, file: string): boolean {
  let found = false;
  visit(node, (n) => {
    if (n.type === "link" && resolvesToRegister(file, n.url) !== null) {
      found = true;
    }
  });
  return found;
}

// 一覧を導く文の直後の箇条書きと、見出しに「残るリスク」を含む節の箇条書きのうち、
// 表へのリンクを持たない項目を数える。
function countUnregisteredRiskBullets(): number {
  let count = 0;
  for (const file of documents()) {
    const tree = parseMarkdown(read(file));
    visit(tree, (node) => {
      if (!("children" in node)) return;
      const children: Nodes[] = node.children;
      let underRiskHeading = false;
      children.forEach((child, i) => {
        if (child.type === "heading") {
          underRiskHeading = text(child).includes("残るリスク");
          return;
        }
        if (child.type !== "list") return;
        const prev = children[i - 1];
        const introduced =
          prev !== undefined &&
          prev.type === "paragraph" &&
          RISK_INTRO.test(text(prev));
        if (!introduced && !underRiskHeading) return;
        for (const item of child.children) {
          if (!linksToRegister(item, file)) count++;
        }
      });
    });
  }
  return count;
}

describe("docs/security-risks.md", () => {
  test("gives every row an ID of the form R-<AREA>-<NN>", () => {
    const malformed = registerEntries()
      .map((e) => e.id)
      .filter((id) => !ID_PATTERN.test(id));
    expect(malformed).toEqual([]);
  });

  test("does not repeat an ID", () => {
    const ids = registerEntries().map((e) => e.id);
    const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(repeated).toEqual([]);
  });

  test("has every ID linked from a section outside the register", () => {
    const linked = new Set(registerLinks().map((l) => l.label));
    const unlinked = registerEntries()
      .map((e) => e.id)
      .filter((id) => !linked.has(id));
    expect(unlinked).toEqual([]);
  });

  test("links each ID to the area heading that holds its row", () => {
    const anchorOf = new Map(registerEntries().map((e) => [e.id, e.anchor]));
    const wrong = registerLinks()
      .filter((l) => ID_PATTERN.test(l.label))
      .filter((l) => anchorOf.get(l.label) !== l.anchor)
      .map((l) => `${l.file}: ${l.label} -> #${l.anchor}`);
    expect(wrong).toEqual([]);
  });

  test("does not let residual-risk bullets outside the register grow", () => {
    expect(countUnregisteredRiskBullets()).toBeLessThanOrEqual(
      UNREGISTERED_RISK_BULLETS_LIMIT,
    );
  });
});
