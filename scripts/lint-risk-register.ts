// 残るリスクの表(`docs/security-risks.md`)と、各節からの行へのリンクを検査する。
// `scripts/lint-docs.ts`から呼ぶ。
//
// 確かめること:
// - 表の行のIDが`R-<領域>-<連番2桁>`の形で、一意である。連番は01から始まる。
// - IDの領域が、略号の表(1列目の見出しが「略号」の表)にある。
// - 行のIDのセルに、IDを小文字にした`<a id>`がある。
// - 各IDに、表の外の文書から、ラベルがそのIDで行のアンカーへ着くリンクがある。
// - ラベルがIDの形で表へ向かうリンクは、表の中のものも含めて、そのIDの行のアンカーへ着く。
// - 領域ごとに、1から略号の表の「使った最大の番号」までの番号が、行か「欠番」の一覧のどちらかに1回ずつある。
//   最大の番号は、IDの連番と同じ2桁(01から99)で書く。最大の番号を超える番号は使わない。
//   最大の番号を表に持つので、最後の番号の行を欠番に挙げずに消しても、gitの履歴を読まずに見つけられる。
//   IDを使い回すと、古いリンクが別のリスクを指すためである。
// - 表の行へのリンクを持たない、受け入れたリスクの語(`RISK_WORDS`)を含む箇所が、
//   許可リスト(`ALLOWLIST_PATH`)にちょうど載っている。
//   載っていない箇所も、載っているのに見つからない箇所も、問題として返す。
// - 許可リストの各行の種類が、`GUIDE_PATH`の「許可の種類」の表にある値である。
//
// 箇所の見つけ方:
// - 表の外の段落のうち、`RISK_WORDS`のどれかを含む文を持つものを1つの箇所とする。
//   行へのリンクを含む文は数えないので、リンクを持つ段落でも、残りの文に語があれば箇所になる。
//   リンクを含むかは、構文木のリンクの範囲で決める。地の文にIDを書いただけの文は、リンクを含む文にならない。
// - 段落の最後の文が`INTRO`と「残るリスク」か受け入れの語(`ACCEPT_WORDS`)を含むとき、その段落は直後の箇条書きを導く。
//   受け入れの語を含まない導く文は、箇所の判定から除く。
//   受け入れの語を含む導く文は、受け入れを書いた文なので、ほかの文と同じく数える。
// - 導く段落の直後の箇条書きと、見出しに`RISK_WORDS`を含む節の直下の箇条書きは、最上位の項目ごとに見る。
//   行へのリンクが無い項目は、1つの箇所とする。
//   行へのリンクがある項目は、リンクを含む文を除いた残りの文に語があるときだけ箇所とする。
//   入れ子の箇条書きは、親の項目の一部として扱う。
//   `RISK_WORDS`を含まない見出しが来ると、その節の扱いは終わる。
// - 行へのリンクとして扱うのは、ラベルが`R-<領域>-<連番2桁>`で、表の行のアンカーへ着くものだけである。
//   参照形式のリンクは、CommonMarkと同じく、同じラベルの最初の定義を引く。
// - 表の文書の中では箇所を探さない。表の行が、受け入れたリスクそのものだからである。
// - 許可リストは、箇所を文書のパスと、本文のハッシュで指す。
//   行の番号で指すと、前に行を足しただけで食い違うためである。
//
// 止められない形:
// - `RISK_WORDS`のどれも使わずに、受け入れたリスクを書いた文。
//   「許す」「見送る」「止めない」のような動詞や、「受け入れ、」のように文の途中で受ける形がこれにあたる。
// - 行へのリンクを含む文の中に、別の受け入れたリスクを書いた形。リンクを含む文は数えないためである。
// - 見出しと表のセルの中の語。どちらも段落でないので見ない。
// - 導く文も`RISK_WORDS`の見出しも持たない箇条書きの項目は、項目の中の段落に語があるときだけ見る。

import { createHash } from "node:crypto";
import type { Nodes } from "mdast";
import * as mdastToString from "mdast-util-to-string";
import { htmlIds, resolveLinkTarget } from "./lint-doc-links.ts";
import { type ReadTree, visit } from "./markdown-tree.ts";

export const REGISTER_PATH = "docs/security-risks.md";

/** 許可の種類の表を持つ文書。 */
export const GUIDE_PATH = "docs/writing-guidelines.md";

/** 表を通さない箇所の許可リスト。1行に1つの箇所を`パス ハッシュ 種類 抜粋`の形で書く。 */
export const ALLOWLIST_PATH = "scripts/lint-risk-register-allowlist.txt";

const RISK_WORD = "残るリスク";

/**
 * 受け入れを表す語。
 * 「受け入れる」と「許容する」は、文の終わりの形だけを見る。
 * 「受け入れるか」「受け入れる理由」のような、受け入れを決めていない言い方を拾わないためである。
 */
const ACCEPT_WORDS = [
  "受け入れたリスク",
  "受け入れる。",
  "受け入れている。",
  "許容する。",
];

/** 箇所を見つける語。 */
const RISK_WORDS = [RISK_WORD, ...ACCEPT_WORDS];

/** 導く文が、後に続く箇条書きを指す言い方。 */
const INTRO = /次の|次を|以下の/;

/** IDの連番と、略号の表の「使った最大の番号」の書式。01から99の2桁。 */
const NUMBER = "0[1-9]|[1-9]\\d";
const ID_PATTERN = new RegExp(`^R-([A-Z]+)-(${NUMBER})$`);
const MAX_PATTERN = new RegExp(`^(?:${NUMBER})$`);
const GAP_HEADING = "欠番";
const AREA_HEADER = "略号";
const MAX_HEADER = "使った最大の番号";
const KIND_HEADER = "許可の種類";
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

/** 本文の中の文。`start`と`end`は、`text`で得た本文の中の位置。 */
type Sentence = {
  readonly value: string;
  readonly start: number;
  readonly end: number;
};

/** 本文を、句点で区切った文にする。空白だけの文は返さない。 */
function sentencesOf(value: string): Sentence[] {
  const sentences: Sentence[] = [];
  let start = 0;
  for (const piece of value.split(/(?<=。)/)) {
    const end = start + piece.length;
    if (piece.trim() !== "") {
      sentences.push({ value: piece.trim(), start, end });
    }
    start = end;
  }
  return sentences;
}

function mentionsAcceptance(value: string): boolean {
  return ACCEPT_WORDS.some((word) => value.includes(word));
}

/** 段落の最後の文が、直後の箇条書きを導く文か。 */
function isIntro(paragraph: Nodes): boolean {
  const last = sentencesOf(text(paragraph)).at(-1)?.value ?? "";
  return (
    INTRO.test(last) && (last.includes(RISK_WORD) || mentionsAcceptance(last))
  );
}

/** 導く文のうち、箇所の判定から除くもの。受け入れの語を含む導く文は、受け入れを書いた文として数える。 */
function isPlainIntro(paragraph: Nodes): boolean {
  const last = sentencesOf(text(paragraph)).at(-1)?.value ?? "";
  return isIntro(paragraph) && !mentionsAcceptance(last);
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

/** 箇所を許可リストに載せるときの1行。`kind`は許可の種類。 */
export function allowlistLine(spot: RiskSpot, kind: string): string {
  return `${spot.path} ${spot.key} ${kind} ${spot.excerpt}`;
}

type Row = { readonly id: string; readonly anchors: readonly string[] };

type Register = {
  /** 略号から、略号の表の「使った最大の番号」のセルの文字列へ。 */
  readonly areas: ReadonlyMap<string, string>;
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

/** 1列目の見出しが`header`の表の各行を、列の見出しからセルの文字列への対応で返す。 */
function tableRows(tree: Nodes, header: string): Map<string, string>[] {
  const rows: Map<string, string>[] = [];
  visit(tree, (node) => {
    if (node.type !== "table") return;
    const [head, ...body] = node.children;
    const names = head?.children.map((cell) => text(cell).trim()) ?? [];
    if (names[0] !== header) return;
    for (const tableRow of body) {
      const cells = new Map<string, string>();
      tableRow.children.forEach((cell, i) => {
        const name = names[i];
        if (name !== undefined) cells.set(name, text(cell).trim());
      });
      rows.push(cells);
    }
  });
  return rows;
}

/** 略号の表、1列目の見出しが「ID」の表の行、「欠番」の見出しの下の一覧を読む。 */
function readRegister(tree: Nodes): Register {
  const areas = new Map<string, string>();
  for (const cells of tableRows(tree, AREA_HEADER)) {
    const code = cells.get(AREA_HEADER);
    if (code !== undefined) areas.set(code, cells.get(MAX_HEADER) ?? "");
  }
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
    if (first === undefined || text(first).trim() !== "ID") continue;
    for (const tableRow of body) {
      const cell = tableRow.children[0];
      if (cell === undefined) continue;
      rows.push({ id: text(cell).trim(), anchors: htmlIdsIn(cell) });
    }
  }
  return { areas, rows, gaps };
}

/** 参照の定義を、CommonMarkと同じく同じラベルの最初の定義で引く。 */
function definitionsOf(tree: Nodes): Map<string, string> {
  const definitions = new Map<string, string>();
  visit(tree, (node) => {
    if (node.type === "definition" && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url);
    }
  });
  return definitions;
}

/** 文書の中で、表の行へ着くリンクの節の集合。 */
type RowLinks = ReadonlySet<Nodes>;

/**
 * `node`の本文の中で、表の行へ着くリンクが占める範囲。
 * 本文は`text`と同じく、子の文字列をつなげて作るので、位置は`text(node)`の中の位置になる。
 */
function rowLinkRanges(
  node: Nodes,
  rowLinks: RowLinks,
): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  let offset = 0;
  const walk = (n: Nodes): void => {
    if (rowLinks.has(n)) {
      const length = text(n).length;
      ranges.push({ start: offset, end: offset + length });
      offset += length;
      return;
    }
    if ("value" in n) {
      offset += text(n).length;
      return;
    }
    if ("children" in n) {
      for (const child of n.children) walk(child);
    }
  };
  walk(node);
  return ranges;
}

/** `node`が表の行へ着くリンクを持つか。 */
function hasRowLink(node: Nodes, rowLinks: RowLinks): boolean {
  return rowLinkRanges(node, rowLinks).length > 0;
}

/** 行へのリンクを含む文を除いた文に、語があるか。`skipLast`は導く文を除くときに使う。 */
function mentionsRiskOutsideLinks(
  node: Nodes,
  rowLinks: RowLinks,
  skipLast = false,
): boolean {
  const ranges = rowLinkRanges(node, rowLinks);
  const sentences = sentencesOf(text(node));
  const considered = skipLast ? sentences.slice(0, -1) : sentences;
  return considered.some(
    (sentence) =>
      mentionsRisk(sentence.value) &&
      !ranges.some(
        (range) => range.start < sentence.end && sentence.start < range.end,
      ),
  );
}

/** `node`の子をたどり、箇所を`spots`に足す。 */
function collectSpots(
  path: string,
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
          if (
            !hasRowLink(item, rowLinks) ||
            mentionsRiskOutsideLinks(item, rowLinks)
          ) {
            spots.push(spotOf(path, item));
          }
        }
        return;
      }
    }
    if (child.type === "paragraph") {
      const next = children[i + 1];
      const skipIntro = next?.type === "list" && isPlainIntro(child);
      if (mentionsRiskOutsideLinks(child, rowLinks, skipIntro)) {
        spots.push(spotOf(path, child));
      }
      return;
    }
    collectSpots(path, child, rowLinks, spots);
  });
}

type Allowlist = {
  /** `パス ハッシュ`ごとの数。 */
  readonly counts: Map<string, number>;
  readonly malformed: readonly string[];
  /** 種類の列の値と、その行。 */
  readonly kinds: readonly { readonly kind: string; readonly line: string }[];
};

/** 許可リストの本文を読む。読めない行は`malformed`に入れる。 */
function readAllowlist(allowlist: string): Allowlist {
  const counts = new Map<string, number>();
  const malformed: string[] = [];
  const kinds: { kind: string; line: string }[] = [];
  for (const raw of allowlist.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const [path, key, kind] = line.split(/\s+/);
    if (
      path === undefined ||
      key === undefined ||
      kind === undefined ||
      !/^[0-9a-f]{16}$/.test(key)
    ) {
      malformed.push(line);
      continue;
    }
    kinds.push({ kind, line });
    const entry = `${path} ${key}`;
    counts.set(entry, (counts.get(entry) ?? 0) + 1);
  }
  return { counts, malformed, kinds };
}

/**
 * 表と節の文書`docs`を検査する。
 * 問題は`docs/security-risks.md: [risk] 内容`の形で返す。
 * 文書は`readTree`の構文木を使い、各文書のリンクは1回だけ解く。
 * `allowlist`は許可リストの本文で、ファイルが無いときは`undefined`。
 */
export function lintRiskRegister(
  docs: readonly string[],
  readTree: ReadTree,
  allowlist: string | undefined,
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
  const idOf = (area: string, n: number): string =>
    `R-${area}-${String(n).padStart(2, "0")}`;
  for (const [area, recorded] of register.areas) {
    if (!MAX_PATTERN.test(recorded)) {
      report(
        `malformed recorded maximum: ${area}: "${recorded}" (two digits from 01 to 99, as in the IDs)`,
      );
      continue;
    }
    const max = Number(recorded);
    const used = numbers.get(area) ?? new Set<number>();
    for (let n = 1; n <= max; n++) {
      if (!used.has(n)) {
        report(`number skipped without a gap entry: ${idOf(area, n)}`);
      }
    }
    for (const n of [...used].sort((a, b) => a - b)) {
      if (n > max)
        report(`number above the recorded maximum: ${idOf(area, n)}`);
    }
  }

  const linked = new Set<string>();
  const spots: RiskSpot[] = [];
  // 表の文書は、IDのリンクが行へ着くかだけを確かめる。表の中のリンクは、節からのリンクに数えない。
  for (const path of docs) {
    const inRegister = path === REGISTER_PATH;
    const tree = inRegister ? own : readTree(path);
    if (tree === undefined) continue;
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
        if (!inRegister) linked.add(label);
        return;
      }
      const line = node.position?.start.line ?? 1;
      report(`link does not reach its row: ${label} (${path}:${line})`);
    });
    if (!inRegister) collectSpots(path, tree, rowLinks, spots);
  }
  for (const row of register.rows) {
    if (ID_PATTERN.test(row.id) && !linked.has(row.id)) {
      report(`ID not linked from any section: ${row.id}`);
    }
  }

  const guide = readTree(GUIDE_PATH);
  const allowedKinds = new Set(
    guide === undefined
      ? []
      : tableRows(guide, KIND_HEADER).flatMap(
          (cells) => cells.get(KIND_HEADER) ?? [],
        ),
  );
  if (allowedKinds.size === 0) {
    report(
      `allowlist kinds not found: the table "${KIND_HEADER}" in ${GUIDE_PATH}`,
    );
  }

  if (allowlist === undefined) {
    report(`allowlist not found: ${ALLOWLIST_PATH}`);
    return { problems, spots };
  }
  const { counts, malformed, kinds } = readAllowlist(allowlist);
  for (const line of malformed) {
    report(`malformed allowlist line in ${ALLOWLIST_PATH}: ${line}`);
  }
  if (allowedKinds.size > 0) {
    for (const { kind, line } of kinds) {
      if (!allowedKinds.has(kind)) {
        report(`unknown allowlist kind: ${kind} (${ALLOWLIST_PATH}: ${line})`);
      }
    }
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
        `Add "${allowlistLine(spot, "<kind>")}" to ${ALLOWLIST_PATH} only when it is not an accepted risk, ` +
        `with a kind from the table "${KIND_HEADER}" in ${GUIDE_PATH}`,
    );
  }
  for (const [entry, left] of counts) {
    for (let n = 0; n < left; n++) {
      report(`allowlist entry not found: ${entry} (${ALLOWLIST_PATH})`);
    }
  }
  return { problems, spots };
}
