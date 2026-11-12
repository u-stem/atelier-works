// 残るリスクの表(`docs/security-risks.md`)と、各節からの行へのリンクを検査する。
// `scripts/lint-docs.ts`から呼ぶ。
//
// 確かめること:
// - 表の行のIDが`R-<領域>-<連番2桁>`の形で、一意である。連番は01から始まる。
// - IDの領域が、略号の表(1列目の見出しが「略号」の表)にある。
// - 行のIDのセルに、IDを小文字にした`<a id>`がある。
// - 各IDに、表の外の文書から、ラベルがそのIDで行のアンカーへ着くリンクがある。
// - ラベルがIDの形で表へ向かうリンクは、そのIDの行のアンカーへ着く。
// - 領域ごとの番号は1から続き、欠けた番号は「欠番」の見出しの下の一覧に1回だけあり、一覧の番号は行に無い。
//   IDを使い回すと、古いリンクが別のリスクを指すためである。
// - 表の行へのリンクを持たない、受け入れたリスクの語(`RISK_WORDS`)を含む箇所が、
//   許可リスト(`ALLOWLIST_PATH`)にちょうど載っている。
//   載っていない箇所も、載っているのに見つからない箇所も、問題として返す。
//
// 箇所の見つけ方:
// - 表の外の段落のうち、`RISK_WORDS`のどれかを含み、行へのリンクを持たないものを1つの箇所とする。
//   ただし、直後の箇条書きを導く段落は、導く文より前の文に`RISK_WORDS`があるときだけ箇所とする。
//   導く文は段落の最後の文で、`RISK_WORDS`のどれかと、`INTRO`を含む。
// - 導く段落の直後の箇条書きと、見出しに`RISK_WORDS`を含む節の直下の箇条書きは、
//   最上位の項目ごとに、項目の中に行へのリンクが無ければ1つの箇所とする。
//   入れ子の箇条書きは、親の項目の一部として扱う。
//   `RISK_WORDS`を含まない見出しが来ると、その節の扱いは終わる。
// - 行へのリンクとして扱うのは、ラベルが`R-<領域>-<連番2桁>`で、表の行のアンカーへ着くものだけである。
//   参照形式のリンクも、定義を引いて同じに扱う。
// - 許可リストは、箇所を文書のパスと、本文のハッシュで指す。
//   行の番号で指すと、前に行を足しただけで食い違うためである。
//
// 止められない形:
// - `RISK_WORDS`のどれも使わずに、受け入れたリスクを書いた文。
//   「許す」「見送る」「止めない」のような動詞や、「受け入れ、」のように文の途中で受ける形がこれにあたる。
// - 見出しと表のセルの中の語。どちらも段落でないので見ない。
// - 導く文も`RISK_WORDS`の見出しも持たない箇条書きの項目は、項目の中の段落に語があるときだけ見る。

import { createHash } from "node:crypto";
import type { Nodes } from "mdast";
import * as mdastToString from "mdast-util-to-string";
import { htmlIds, resolveLinkTarget } from "./lint-doc-links.ts";
import { type ReadTree, visit } from "./markdown-tree.ts";

export const REGISTER_PATH = "docs/security-risks.md";

/** 表を通さない箇所の許可リスト。1行に1つの箇所を`パス ハッシュ 抜粋`の形で書く。 */
export const ALLOWLIST_PATH = "scripts/lint-risk-register-allowlist.txt";

/**
 * 受け入れたリスクを表す語。
 * 「受け入れる」と「許容する」は、文の終わりの形だけを見る。
 * 「受け入れるか」「受け入れる理由」のような、受け入れを決めていない言い方を拾わないためである。
 */
const RISK_WORDS = [
  "残るリスク",
  "受け入れたリスク",
  "受け入れる。",
  "受け入れている。",
  "許容する。",
];

/** 導く文が、後に続く箇条書きを指す言い方。 */
const INTRO = /次(の|を)|がある。$/;

const ID_PATTERN = /^R-([A-Z]+)-(0[1-9]|[1-9]\d)$/;
const GAP_HEADING = "欠番";
const AREA_HEADER = "略号";
const EXCERPT_LENGTH = 40;

function text(node: Nodes): string {
  return mdastToString.toString(node, {
    includeHtml: false,
    includeImageAlt: false,
  });
}

/** 改行と連続する空白を1つの空白にした本文。ハッシュと抜粋はこの形から作る。 */
function normalized(node: Nodes): string {
  return text(node).replace(/\s+/g, " ").trim();
}

function mentionsRisk(value: string): boolean {
  return RISK_WORDS.some((word) => value.includes(word));
}

/** 段落の文を、句点で区切って返す。 */
function sentencesOf(value: string): string[] {
  return value
    .split(/(?<=。)/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");
}

/** 段落の最後の文が、直後の箇条書きを導く文か。 */
function isIntro(paragraph: Nodes): boolean {
  const last = sentencesOf(text(paragraph)).at(-1) ?? "";
  return mentionsRisk(last) && INTRO.test(last);
}

/** 導く段落のうち、導く文より前の文に語があるか。 */
function mentionsRiskBeforeIntro(paragraph: Nodes): boolean {
  return sentencesOf(text(paragraph)).slice(0, -1).some(mentionsRisk);
}

/** 表の行へのリンクを持たない、受け入れたリスクの語を含む箇所。 */
export type RiskSpot = {
  readonly path: string;
  /** 箇所の始まりの行。1始まり。 */
  readonly line: number;
  /** 本文のハッシュ。許可リストはこの値で箇所を指す。 */
  readonly key: string;
  readonly excerpt: string;
};

/** 検査の結果。`spots`は、許可リストに載っているかにかかわらず、見つけた箇所のすべて。 */
export type RiskRegisterResult = {
  readonly problems: readonly string[];
  readonly spots: readonly RiskSpot[];
};

function spotOf(path: string, node: Nodes): RiskSpot {
  const body = normalized(node);
  return {
    path,
    line: node.position?.start.line ?? 1,
    key: createHash("sha256").update(body).digest("hex").slice(0, 16),
    excerpt: body.slice(0, EXCERPT_LENGTH),
  };
}

/** 箇所を許可リストに載せるときの1行。 */
export function allowlistLine(spot: RiskSpot): string {
  return `${spot.path} ${spot.key} ${spot.excerpt}`;
}

type Row = { readonly id: string; readonly anchors: readonly string[] };

type Register = {
  readonly areas: ReadonlySet<string>;
  readonly rows: readonly Row[];
  readonly gaps: readonly string[];
};

function htmlIdsIn(node: Nodes): string[] {
  const ids: string[] = [];
  visit(node, (n) => {
    if (n.type === "html") ids.push(...htmlIds(n.value));
  });
  return ids;
}

/** 略号の表、1列目の見出しが「ID」の表の行、「欠番」の見出しの下の一覧を読む。 */
function readRegister(tree: Nodes): Register {
  const areas = new Set<string>();
  const rows: Row[] = [];
  const gaps: string[] = [];
  if (!("children" in tree)) return { areas, rows, gaps };
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
    if (first === undefined) continue;
    const kind = text(first).trim();
    for (const tableRow of body) {
      const cell = tableRow.children[0];
      if (cell === undefined) continue;
      if (kind === AREA_HEADER) areas.add(text(cell).trim());
      if (kind === "ID") {
        rows.push({ id: text(cell).trim(), anchors: htmlIdsIn(cell) });
      }
    }
  }
  return { areas, rows, gaps };
}

function definitionsOf(tree: Nodes): Map<string, string> {
  const definitions = new Map<string, string>();
  visit(tree, (node) => {
    if (node.type === "definition") definitions.set(node.identifier, node.url);
  });
  return definitions;
}

type Doc = { readonly path: string; readonly tree: Nodes };

/** 文書の中で、表の行へ着くリンクの節の集合。 */
type RowLinks = ReadonlySet<Nodes>;

function hasRowLink(node: Nodes, rowLinks: RowLinks): boolean {
  let found = false;
  visit(node, (n) => {
    if (rowLinks.has(n)) found = true;
  });
  return found;
}

/** `node`の子をたどり、行へのリンクを持たない箇所を`spots`に足す。 */
function collectSpots(
  doc: Doc,
  node: Nodes,
  rowLinks: RowLinks,
  spots: RiskSpot[],
): void {
  if (!("children" in node)) return;
  const children: Nodes[] = node.children;
  let underRiskHeading = false;
  children.forEach((child, i) => {
    if (child.type === "heading") {
      underRiskHeading = mentionsRisk(text(child));
      return;
    }
    if (child.type === "table") return;
    if (child.type === "list") {
      const prev = children[i - 1];
      const introduced = prev?.type === "paragraph" && isIntro(prev);
      if (introduced || underRiskHeading) {
        for (const item of child.children) {
          if (!hasRowLink(item, rowLinks)) spots.push(spotOf(doc.path, item));
        }
        return;
      }
    }
    if (child.type === "paragraph") {
      const next = children[i + 1];
      const introducesList = next?.type === "list" && isIntro(child);
      const mentions = introducesList
        ? mentionsRiskBeforeIntro(child)
        : mentionsRisk(text(child));
      if (mentions && !hasRowLink(child, rowLinks)) {
        spots.push(spotOf(doc.path, child));
      }
      return;
    }
    collectSpots(doc, child, rowLinks, spots);
  });
}

/** 許可リストの本文を、`パス ハッシュ`ごとの数にする。読めない行は`malformed`に入れる。 */
function readAllowlist(allowlist: string): {
  readonly counts: Map<string, number>;
  readonly malformed: readonly string[];
} {
  const counts = new Map<string, number>();
  const malformed: string[] = [];
  for (const raw of allowlist.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const [path, key] = line.split(/\s+/);
    if (
      path === undefined ||
      key === undefined ||
      !/^[0-9a-f]{16}$/.test(key)
    ) {
      malformed.push(line);
      continue;
    }
    const entry = `${path} ${key}`;
    counts.set(entry, (counts.get(entry) ?? 0) + 1);
  }
  return { counts, malformed };
}

/**
 * 表と節の文書`docs`を検査する。
 * 問題は`docs/security-risks.md: [risk] 内容`の形で返す。
 * 文書は`readTree`の構文木を使い、各文書のリンクは1回だけ解く。
 * `allowlist`は許可リストの本文。
 */
export function lintRiskRegister(
  docs: readonly string[],
  readTree: ReadTree,
  allowlist: string,
): RiskRegisterResult {
  const problems: string[] = [];
  const report = (reason: string): void => {
    problems.push(`${REGISTER_PATH}: [risk] ${reason}`);
  };
  const own = readTree(REGISTER_PATH);
  if (own === undefined) {
    report("register not found");
    return { problems, spots: [] };
  }
  const register = readRegister(own);

  const seen = new Set<string>();
  const numbers = new Map<string, Set<number>>();
  const use = (id: string, match: RegExpExecArray): void => {
    const area = match[1] ?? "";
    if (!register.areas.has(area)) report(`unknown area code: ${id}`);
    const used = numbers.get(area) ?? new Set<number>();
    used.add(Number(match[2]));
    numbers.set(area, used);
  };
  const rowAnchors = new Set<string>();
  for (const row of register.rows) {
    const match = ID_PATTERN.exec(row.id);
    if (match === null) {
      report(`malformed ID: ${row.id}`);
      continue;
    }
    if (seen.has(row.id)) report(`repeated ID: ${row.id}`);
    seen.add(row.id);
    const anchor = row.id.toLowerCase();
    if (row.anchors.includes(anchor)) rowAnchors.add(anchor);
    else report(`row anchor missing: ${row.id}`);
    use(row.id, match);
  }

  const gapsSeen = new Set<string>();
  for (const gap of register.gaps) {
    const match = ID_PATTERN.exec(gap);
    if (match === null) {
      report(`malformed gap entry: ${gap}`);
      continue;
    }
    if (gapsSeen.has(gap)) report(`repeated gap entry: ${gap}`);
    gapsSeen.add(gap);
    if (seen.has(gap)) report(`gap entry is a row: ${gap}`);
    use(gap, match);
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

  const linked = new Set<string>();
  const spots: RiskSpot[] = [];
  for (const path of docs) {
    if (path === REGISTER_PATH) continue;
    const tree = readTree(path);
    if (tree === undefined) continue;
    const doc = { path, tree };
    const definitions = definitionsOf(tree);
    const rowLinks = new Set<Nodes>();
    visit(tree, (node) => {
      const url =
        node.type === "link"
          ? node.url
          : node.type === "linkReference"
            ? definitions.get(node.identifier)
            : undefined;
      if (url === undefined) return;
      const label = text(node);
      if (!ID_PATTERN.test(label)) return;
      const target = resolveLinkTarget(path, url);
      if (target === undefined || target.path !== REGISTER_PATH) return;
      if (
        target.anchor === label.toLowerCase() &&
        rowAnchors.has(target.anchor)
      ) {
        rowLinks.add(node);
        linked.add(label);
        return;
      }
      const line = node.position?.start.line ?? 1;
      report(`link does not reach its row: ${label} (${path}:${line})`);
    });
    collectSpots(doc, tree, rowLinks, spots);
  }
  for (const row of register.rows) {
    if (ID_PATTERN.test(row.id) && !linked.has(row.id)) {
      report(`ID not linked from any section: ${row.id}`);
    }
  }

  const { counts, malformed } = readAllowlist(allowlist);
  for (const line of malformed) {
    report(`malformed allowlist line in ${ALLOWLIST_PATH}: ${line}`);
  }
  for (const spot of spots) {
    const entry = `${spot.path} ${spot.key}`;
    const left = counts.get(entry) ?? 0;
    if (left > 0) {
      counts.set(entry, left - 1);
      continue;
    }
    report(
      `unregistered residual risk: ${spot.path}:${spot.line}: ${spot.excerpt}. ` +
        `If it is an accepted risk, add a row to ${REGISTER_PATH} and link to it by ID from the section. ` +
        `Add "${allowlistLine(spot)}" to ${ALLOWLIST_PATH} only when it is not an accepted risk, such as an unverified assumption or follow-up work`,
    );
  }
  for (const [entry, left] of counts) {
    for (let n = 0; n < left; n++) {
      report(`allowlist entry not found: ${entry} (${ALLOWLIST_PATH})`);
    }
  }
  return { problems, spots };
}
