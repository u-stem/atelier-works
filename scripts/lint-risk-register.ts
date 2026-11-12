// 残るリスクの表(`docs/security-risks.md`)と、各節からの行へのリンクを検査する。
// `scripts/lint-docs.ts`から呼ぶ。
//
// 確かめること:
// - 表の行のIDが`R-<領域>-<連番2桁>`の形で、一意である。
// - 行のIDのセルに、IDを小文字にした`<a id>`がある。
// - 各IDに、表の外の文書から、ラベルがそのIDで行のアンカーへ着くリンクがある。
// - ラベルがIDの形で表へ向かうリンクは、そのIDの行のアンカーへ着く。
// - 領域ごとの番号は1から続き、欠けた番号は「欠番」の見出しの下の一覧にあり、一覧の番号は行に無い。
//   IDを使い回すと、古いリンクが別のリスクを指すためである。
// - 表に、置き場所の仮の語(`FORBIDDEN_WORDS`)が無い。
// - 表の行へのリンクを持たない「残るリスク」の段落と箇条書きの数が、`UNREGISTERED_RISKS`とちょうど同じである。
//   表を通さない残るリスクが増えたとき、減ったときのどちらも、この定数の更新を求める。
//
// 数え方:
// - 表の外の段落のうち、「残るリスク」を含み、行へのリンクを持たないものを1つと数える。
//   ただし、直後の箇条書きを導く文(`RISK_INTRO`)は、段落としては数えない。
// - 導く文の直後の箇条書きと、見出しに「残るリスク」を含む節の直下の箇条書きは、
//   最上位の項目ごとに、項目の中に行へのリンクが無ければ1つと数える。
//   入れ子の箇条書きは、親の項目の一部として数える。
//   「残るリスク」を含まない見出しが来ると、その節の数え方は終わる。
// - 行へのリンクとして数えるのは、ラベルが`R-<領域>-<連番2桁>`で、表の行のアンカーへ着くものだけである。
//   参照形式のリンクも、定義を引いて同じに扱う。
//
// 止められない形:
// - 「残るリスク」の語を使わずに、受け入れたリスクを書いた文。
// - 見出しと表のセルの中の「残るリスク」。
//   どちらも段落でないので数えない。
// - 導く文も「残るリスク」の見出しも持たない箇条書きの項目。
//   項目の中の段落として、「残るリスク」の語を含むときだけ数える。

import type { Nodes } from "mdast";
import * as mdastToString from "mdast-util-to-string";
import { resolveLinkTarget } from "./lint-doc-links.ts";
import { parseMarkdown, visit } from "./markdown-tree.ts";

export const REGISTER_PATH = "docs/security-risks.md";

/** 表の行へのリンクを持たない「残るリスク」の段落と箇条書きの、ちょうどの数。 */
export const UNREGISTERED_RISKS = 97;

const ID_PATTERN = /^R-([A-Z]+)-(\d{2})$/;
const RISK_WORD = "残るリスク";
const RISK_INTRO =
  /残るリスク.*(次のとおり|次の[0-9０-９一二三四五六七八九十]+つ|次の回避|がある。)/;
const GAP_HEADING = "欠番";
const FORBIDDEN_WORDS = ["元の文に無い", "説明にある"];
const HTML_ID = /\bid\s*=\s*"([^"]*)"/g;

/** 文書の本文を返す。読めないパスは`undefined`。 */
export type ReadDoc = (path: string) => string | undefined;

function text(node: Nodes): string {
  return mdastToString.toString(node, {
    includeHtml: false,
    includeImageAlt: false,
  });
}

type Row = { readonly id: string; readonly anchors: readonly string[] };

type Register = {
  readonly rows: readonly Row[];
  readonly gaps: readonly string[];
};

function htmlIdsIn(node: Nodes): string[] {
  const ids: string[] = [];
  visit(node, (n) => {
    if (n.type !== "html") return;
    for (const match of n.value.matchAll(HTML_ID)) {
      if (match[1] !== undefined) ids.push(match[1]);
    }
  });
  return ids;
}

/** 1列目の見出しが「ID」の表の行と、「欠番」の見出しの下の一覧を読む。 */
function readRegister(tree: Nodes): Register {
  const rows: Row[] = [];
  const gaps: string[] = [];
  if (!("children" in tree)) return { rows, gaps };
  let inGaps = false;
  for (const node of tree.children) {
    if (node.type === "heading") {
      inGaps = text(node).trim() === GAP_HEADING;
      continue;
    }
    if (node.type === "list" && inGaps) {
      for (const item of node.children) gaps.push(text(item).trim());
      continue;
    }
    if (node.type !== "table") continue;
    const [header, ...body] = node.children;
    const first = header?.children[0];
    if (first === undefined || text(first).trim() !== "ID") continue;
    for (const tableRow of body) {
      const cell = tableRow.children[0];
      if (cell === undefined) continue;
      rows.push({ id: text(cell).trim(), anchors: htmlIdsIn(cell) });
    }
  }
  return { rows, gaps };
}

type Link = {
  readonly label: string;
  readonly url: string;
  readonly line: number;
};

function definitionsOf(tree: Nodes): Map<string, string> {
  const definitions = new Map<string, string>();
  visit(tree, (node) => {
    if (node.type === "definition") definitions.set(node.identifier, node.url);
  });
  return definitions;
}

/** `node`の中のリンクを、参照形式は定義を引いて返す。 */
function linksIn(
  node: Nodes,
  definitions: ReadonlyMap<string, string>,
): Link[] {
  const links: Link[] = [];
  visit(node, (n) => {
    const line = n.position?.start.line ?? 1;
    if (n.type === "link") links.push({ label: text(n), url: n.url, line });
    if (n.type === "linkReference") {
      const url = definitions.get(n.identifier);
      if (url !== undefined) links.push({ label: text(n), url, line });
    }
  });
  return links;
}

type Parsed = {
  readonly path: string;
  readonly tree: Nodes;
  readonly definitions: ReadonlyMap<string, string>;
};

/** ラベルがIDで、表の行のアンカーへ着くリンクか。 */
function isRowLink(
  doc: Parsed,
  link: Link,
  rowAnchors: ReadonlySet<string>,
): boolean {
  if (!ID_PATTERN.test(link.label)) return false;
  const target = resolveLinkTarget(doc.path, link.url);
  return (
    target !== undefined &&
    target.path === REGISTER_PATH &&
    target.anchor === link.label.toLowerCase() &&
    rowAnchors.has(target.anchor)
  );
}

function hasRowLink(
  doc: Parsed,
  node: Nodes,
  rowAnchors: ReadonlySet<string>,
): boolean {
  return linksIn(node, doc.definitions).some((link) =>
    isRowLink(doc, link, rowAnchors),
  );
}

function countIn(
  doc: Parsed,
  node: Nodes,
  rowAnchors: ReadonlySet<string>,
): number {
  if (!("children" in node)) return 0;
  const children: Nodes[] = node.children;
  let count = 0;
  let underRiskHeading = false;
  children.forEach((child, i) => {
    if (child.type === "heading") {
      underRiskHeading = text(child).includes(RISK_WORD);
      return;
    }
    if (child.type === "table") return;
    if (child.type === "list") {
      const prev = children[i - 1];
      const introduced =
        prev !== undefined &&
        prev.type === "paragraph" &&
        RISK_INTRO.test(text(prev));
      if (introduced || underRiskHeading) {
        for (const item of child.children) {
          if (!hasRowLink(doc, item, rowAnchors)) count++;
        }
        return;
      }
    }
    if (child.type === "paragraph") {
      const next = children[i + 1];
      const introducesList =
        next !== undefined &&
        next.type === "list" &&
        RISK_INTRO.test(text(child));
      if (
        !introducesList &&
        text(child).includes(RISK_WORD) &&
        !hasRowLink(doc, child, rowAnchors)
      ) {
        count++;
      }
      return;
    }
    count += countIn(doc, child, rowAnchors);
  });
  return count;
}

function parseAll(docs: readonly string[], read: ReadDoc): Parsed[] {
  const parsed: Parsed[] = [];
  for (const path of docs) {
    const markdown = read(path);
    if (markdown === undefined) continue;
    const tree = parseMarkdown(markdown);
    parsed.push({ path, tree, definitions: definitionsOf(tree) });
  }
  return parsed;
}

function rowAnchorsOf(register: Register): Set<string> {
  const anchors = new Set<string>();
  for (const row of register.rows) {
    const expected = row.id.toLowerCase();
    if (row.anchors.includes(expected)) anchors.add(expected);
  }
  return anchors;
}

function count(parsed: readonly Parsed[], rowAnchors: ReadonlySet<string>) {
  return parsed
    .filter((doc) => doc.path !== REGISTER_PATH)
    .reduce((sum, doc) => sum + countIn(doc, doc.tree, rowAnchors), 0);
}

/** 表の行へのリンクを持たない「残るリスク」の段落と箇条書きを数える。 */
export function countUnregisteredRisks(
  docs: readonly string[],
  read: ReadDoc,
): number {
  const parsed = parseAll(docs, read);
  const own = parsed.find((doc) => doc.path === REGISTER_PATH);
  const register =
    own === undefined ? { rows: [], gaps: [] } : readRegister(own.tree);
  return count(parsed, rowAnchorsOf(register));
}

/**
 * 表と節の文書`docs`を検査し、問題を`docs/security-risks.md: [risk] 内容`の形で返す。
 * 各文書は1回だけ読む。
 */
export function lintRiskRegister(
  docs: readonly string[],
  read: ReadDoc,
  expectedUnregistered: number = UNREGISTERED_RISKS,
): string[] {
  const problems: string[] = [];
  const report = (reason: string): void => {
    problems.push(`${REGISTER_PATH}: [risk] ${reason}`);
  };
  const parsed = parseAll(docs, read);
  const own = parsed.find((doc) => doc.path === REGISTER_PATH);
  if (own === undefined) {
    report("register not found");
    return problems;
  }
  const register = readRegister(own.tree);
  const rowAnchors = rowAnchorsOf(register);

  const seen = new Set<string>();
  const numbers = new Map<string, Set<number>>();
  for (const row of register.rows) {
    const match = ID_PATTERN.exec(row.id);
    if (match === null) {
      report(`malformed ID: ${row.id}`);
      continue;
    }
    if (seen.has(row.id)) report(`repeated ID: ${row.id}`);
    seen.add(row.id);
    if (!row.anchors.includes(row.id.toLowerCase())) {
      report(`row anchor missing: ${row.id}`);
    }
    const area = match[1] ?? "";
    const used = numbers.get(area) ?? new Set<number>();
    used.add(Number(match[2]));
    numbers.set(area, used);
  }

  for (const gap of register.gaps) {
    const match = ID_PATTERN.exec(gap);
    if (match === null) {
      report(`malformed gap entry: ${gap}`);
      continue;
    }
    if (seen.has(gap)) report(`gap entry is a row: ${gap}`);
    const area = match[1] ?? "";
    const used = numbers.get(area) ?? new Set<number>();
    used.add(Number(match[2]));
    numbers.set(area, used);
  }
  for (const [area, used] of numbers) {
    const max = Math.max(...used);
    for (let n = 1; n <= max; n++) {
      if (!used.has(n)) {
        report(
          `number skipped without a gap entry: R-${area}-${String(n).padStart(2, "0")}`,
        );
      }
    }
  }

  const registerText = read(REGISTER_PATH) ?? "";
  for (const word of FORBIDDEN_WORDS) {
    if (registerText.includes(word)) report(`forbidden word: ${word}`);
  }

  const linked = new Set<string>();
  for (const doc of parsed) {
    if (doc.path === REGISTER_PATH) continue;
    for (const link of linksIn(doc.tree, doc.definitions)) {
      if (!ID_PATTERN.test(link.label)) continue;
      const target = resolveLinkTarget(doc.path, link.url);
      if (target === undefined || target.path !== REGISTER_PATH) continue;
      if (isRowLink(doc, link, rowAnchors)) {
        linked.add(link.label);
      } else {
        report(
          `link does not reach its row: ${link.label} (${doc.path}:${link.line})`,
        );
      }
    }
  }
  for (const row of register.rows) {
    if (ID_PATTERN.test(row.id) && !linked.has(row.id)) {
      report(`ID not linked from any section: ${row.id}`);
    }
  }

  const unregistered = count(parsed, rowAnchors);
  if (unregistered !== expectedUnregistered) {
    report(
      `unregistered residual risks: ${unregistered}, expected ${expectedUnregistered}. Update UNREGISTERED_RISKS in scripts/lint-risk-register.ts only after checking the change`,
    );
  }
  return problems;
}
