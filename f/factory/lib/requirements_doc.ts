// headless Claudeが書いた要件定義書(`.claude/skills/factory-requirements/`の
// `template.md`と`SKILL.md`)を機械的に検査する。
// すべてI/OやWindmill・GitHubに依存しない純粋関数のため、パイプライン
// (工程2で生成後に`steps/pipeline_generate.ts`が行う検査)と同じ検査を
// 単体テストでも行える。
//
// 各`check*`関数は日本語の問題点の一覧を返す(問題が無ければ空)。
// `validateRequirementsDoc`はそれらをまとめて1つの結果にする。

import {
  checkProse,
  formatProseIssues,
  type ProseRegister,
  type ProseRuleId,
  type ProseRules,
  REPORT_RULES,
} from "./prose_check.ts";
import {
  DIAGRAM_NAME_PATTERN,
  DIAGRAM_REF_PATTERN,
  MAX_DIAGRAMS,
  MAX_DOC_CHARS,
  MAX_LINE_CHARS,
  MAX_SENTENCES_PER_PARAGRAPH,
  REQUIREMENT_ID_PATTERNS,
  REQUIREMENTS_SECTIONS,
} from "./requirements_template.ts";

// ---------------------------------------------------------------------------
// 見出し
// ---------------------------------------------------------------------------

const H2_HEADING_PATTERN = /^##\s+(.*\S)\s*$/;

/**
 * `markdown`の`##`見出し(`#`がちょうど2つで、`###`以上は含まない)の文字列を、
 * 現れる順にすべて返す。
 * コードフェンスは特別扱いしない。文書にコードフェンスがあること自体を
 * 想定しておらず(`checkForbiddenSyntax`を参照)、フェンス内の`##`に見える行は
 * 黙って飛ばさず、問題として表に出すべきものだからである。
 */
export function extractH2Headings(markdown: string): string[] {
  const headings: string[] = [];
  for (const line of markdown.split("\n")) {
    const match = line.match(H2_HEADING_PATTERN);
    if (match !== null) {
      headings.push(match[1] ?? "");
    }
  }
  return headings;
}

/**
 * `markdown`の`##`見出しが、順序も含めて`REQUIREMENTS_SECTIONS`と
 * 完全に一致するかを検査する。
 * 見出しの欠落、余分な見出し、順序の違いをそれぞれ区別して報告する。
 */
export function checkSections(markdown: string): string[] {
  const actual = extractH2Headings(markdown);
  const expectedSet = new Set(REQUIREMENTS_SECTIONS);
  const actualSet = new Set(actual);
  const issues: string[] = [];

  for (const heading of REQUIREMENTS_SECTIONS) {
    if (!actualSet.has(heading)) {
      issues.push(`章が見つかりません: 「${heading}」`);
    }
  }
  for (const heading of actual) {
    if (!expectedSet.has(heading)) {
      issues.push(`規定にない章があります: 「${heading}」`);
    }
  }

  if (issues.length === 0) {
    const inOrder =
      actual.length === REQUIREMENTS_SECTIONS.length &&
      actual.every(
        (heading, index) => heading === REQUIREMENTS_SECTIONS[index],
      );
    if (!inOrder) {
      issues.push(
        `章の順序が規定と一致しません(期待: ${REQUIREMENTS_SECTIONS.join(" > ")} / 実際: ${actual.join(" > ")})`,
      );
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Markdownの表の解析(`checkRequirementIds` / `checkDiagramRefs`で共有)
// ---------------------------------------------------------------------------

/**
 * `## <heading>`の節の本文(次の`##`までの行)を返す。見出しが無ければ`""`を返す。
 * `implement_support.ts`の`extractAcceptanceCriteria`も使うためexportしている。
 */
export function extractSectionBody(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const startIndex = lines.findIndex(
    (line) => line.match(H2_HEADING_PATTERN)?.[1] === heading,
  );
  if (startIndex === -1) {
    return "";
  }
  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    if (H2_HEADING_PATTERN.test(lines[i] ?? "")) {
      endIndex = i;
      break;
    }
  }
  return lines.slice(startIndex + 1, endIndex).join("\n");
}

function isTableSeparatorRow(cells: readonly string[]): boolean {
  return cells.every((cell) => /^:?-+:?$/.test(cell.trim()));
}

/**
 * `body`の中の`| a | b |`形式の表を解析し、データ行だけを返す
 * (見出し行と区切り行は落とす)。セルの値は前後の空白を除く。
 */
function extractTableRows(body: string): string[][] {
  const tableLines = body
    .split("\n")
    .filter((line) => line.trim().startsWith("|"));
  const rows = tableLines.map((line) => {
    const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    return trimmed.split("|").map((cell) => cell.trim());
  });
  if (rows.length < 2 || !isTableSeparatorRow(rows[1] ?? [])) {
    return [];
  }
  return rows.slice(2);
}

// ---------------------------------------------------------------------------
// 要件と受入条件のID
// ---------------------------------------------------------------------------

type IdKind = keyof typeof REQUIREMENT_ID_PATTERNS;

/**
 * IDの列1つを検査し(形式、重複、001から欠番の無い連番)、
 * 形式が正しく重複の無いIDを表の順に返す。
 * 見つけた問題点は`issues`に追加する。
 */
function checkIdColumn(
  rows: readonly (readonly string[])[],
  kind: IdKind,
  issues: string[],
): string[] {
  const pattern = REQUIREMENT_ID_PATTERNS[kind];
  const seen = new Set<string>();
  const ids: string[] = [];

  for (const row of rows) {
    const id = (row[0] ?? "").trim();
    if (id === "") {
      continue;
    }
    if (!pattern.test(id)) {
      issues.push(
        `IDの形式が不正です: 「${id}」(${kind}-連番3桁の形式にしてください)`,
      );
      continue;
    }
    if (seen.has(id)) {
      issues.push(`IDが重複しています: 「${id}」`);
      continue;
    }
    seen.add(id);
    ids.push(id);
  }

  const numbers = ids
    .map((id) => Number.parseInt(id.slice(id.indexOf("-") + 1), 10))
    .sort((a, b) => a - b);
  for (let i = 0; i < numbers.length; i += 1) {
    const expected = i + 1;
    if (numbers[i] !== expected) {
      issues.push(
        `${kind}のIDが連番になっていません(${String(expected).padStart(3, "0")}番が欠番の可能性があります)`,
      );
      break;
    }
  }

  return ids;
}

/**
 * 機能要件・非機能要件・受入条件の各節にあるFR / NFR / ACのIDの列を検査する。
 * 形式、重複の無さ、001から欠番の無い連番を確かめる。
 * さらに、各受入条件の対象要件が存在するFRを指すことと、
 * 各FRを参照する受入条件が1つ以上あることも確かめる。
 */
export function checkRequirementIds(markdown: string): string[] {
  const issues: string[] = [];

  const frRows = extractTableRows(extractSectionBody(markdown, "機能要件"));
  const nfrRows = extractTableRows(extractSectionBody(markdown, "非機能要件"));
  const acRows = extractTableRows(extractSectionBody(markdown, "受入条件"));

  if (frRows.length === 0) {
    issues.push("機能要件が1件もありません");
  }
  if (acRows.length === 0) {
    issues.push("受入条件が1件もありません");
  }

  const frIds = checkIdColumn(frRows, "FR", issues);
  checkIdColumn(nfrRows, "NFR", issues);
  checkIdColumn(acRows, "AC", issues);

  const frIdSet = new Set(frIds);
  const referencedFrIds = new Set<string>();
  for (const row of acRows) {
    const acId = (row[0] ?? "").trim();
    const targetFr = (row[1] ?? "").trim();
    if (targetFr === "") {
      continue;
    }
    if (!frIdSet.has(targetFr)) {
      issues.push(
        `受入条件${acId}の対象要件「${targetFr}」が機能要件に存在しません`,
      );
      continue;
    }
    referencedFrIds.add(targetFr);
  }

  for (const frId of frIds) {
    if (!referencedFrIds.has(frId)) {
      issues.push(`機能要件${frId}に対応する受入条件がありません`);
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// 禁止する記法(スキルが明示的に禁じるAI文章の癖)
// ---------------------------------------------------------------------------

const CODE_FENCE_PATTERN = /```/;
const BOLD_PATTERN = /\*\*/;
const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;
// Markdownの自動リンク(`<https://...>` / `<http://...>`)は正しい記法であり、
// 残ったHTMLタグや埋めていない`<...>`のプレースホルダではないため除く。
const HTML_TAG_OR_PLACEHOLDER_PATTERN = /<(?!https?:\/\/)[^<>\n]+>/g;
const ALERT_LINE_PATTERN = /^>\s*\[!([A-Za-z]+)\]/;
const ALLOWED_ALERT_KINDS = new Set(["NOTE", "WARNING", "IMPORTANT"]);

/**
 * 要件定義のスキルが明示的に禁じるAI文章の癖を検出する。
 * 対象は、コードフェンス、`**`の太字、絵文字、残ったHTMLタグや
 * 埋めていない`<...>`のプレースホルダ、`[!NOTE]` / `[!WARNING]` /
 * `[!IMPORTANT]`以外のアラートである。
 */
export function checkForbiddenSyntax(markdown: string): string[] {
  const issues: string[] = [];

  if (CODE_FENCE_PATTERN.test(markdown)) {
    issues.push("コードフェンス(```)が含まれています");
  }
  if (BOLD_PATTERN.test(markdown)) {
    issues.push("太字記法(**)が含まれています");
  }

  const lines = markdown.split("\n");
  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    if (EMOJI_PATTERN.test(line)) {
      issues.push(`${lineNumber}行目: 絵文字が含まれています`);
    }

    for (const match of line.matchAll(HTML_TAG_OR_PLACEHOLDER_PATTERN)) {
      issues.push(
        `${lineNumber}行目: HTMLタグまたは未記入のプレースホルダが残っています: ${match[0]}`,
      );
    }

    const alertMatch = line.match(ALERT_LINE_PATTERN);
    if (alertMatch !== null && !ALLOWED_ALERT_KINDS.has(alertMatch[1] ?? "")) {
      issues.push(
        `${lineNumber}行目: 許可されていないアラート種別です: ${line.trim()}`,
      );
    }
  });

  return issues;
}

// ---------------------------------------------------------------------------
// 引用とアラート
// ---------------------------------------------------------------------------

const EMPTY_QUOTE_LINE_PATTERN = /^>\s*$/;
const QUOTE_CONTENT_LINE_PATTERN = /^>\s*\S/;

/**
 * 引用に中身があるかを検査する。
 * 後ろに何も無い`>`だけの行が無いことと、`> [!KIND]`のアラートの見出しの
 * 直後に、`>`で始まる空でない本文の行が続くことを確かめる。
 */
export function checkQuotes(markdown: string): string[] {
  const issues: string[] = [];
  const lines = markdown.split("\n");

  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    if (EMPTY_QUOTE_LINE_PATTERN.test(line)) {
      issues.push(`${lineNumber}行目: 空の引用行があります`);
    }

    if (ALERT_LINE_PATTERN.test(line)) {
      const nextLine = lines[index + 1];
      if (
        nextLine === undefined ||
        !QUOTE_CONTENT_LINE_PATTERN.test(nextLine)
      ) {
        issues.push(
          `${lineNumber}行目: 本文のないアラートです: ${line.trim()}`,
        );
      }
    }
  });

  return issues;
}

// ---------------------------------------------------------------------------
// 長さと段落の密度
// ---------------------------------------------------------------------------

function isProseLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "") return false;
  if (trimmed.startsWith("#")) return false;
  if (trimmed.startsWith("|")) return false;
  if (trimmed.startsWith(">")) return false;
  if (trimmed.startsWith("-")) return false;
  if (trimmed.startsWith("!")) return false;
  if (trimmed.startsWith("<")) return false;
  return true;
}

/** `markdown`の行を、空行で区切られたブロックにまとめる。 */
function splitIntoBlocks(markdown: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of markdown.split("\n")) {
    if (line.trim() === "") {
      if (current.length > 0) {
        blocks.push(current);
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) {
    blocks.push(current);
  }
  return blocks;
}

/**
 * 1行の長さ、文書全体の長さ、段落ごとの文の数(`。`で区切る)を検査する。
 * 表・見出し・引用・リスト・図の埋め込みは段落の検査から除く。
 */
export function checkLengths(markdown: string): string[] {
  const issues: string[] = [];

  markdown.split("\n").forEach((line, index) => {
    if (line.length > MAX_LINE_CHARS) {
      issues.push(
        `${index + 1}行目が${MAX_LINE_CHARS}文字を超えています(${line.length}文字)`,
      );
    }
  });

  if (markdown.length > MAX_DOC_CHARS) {
    issues.push(
      `文書全体が${MAX_DOC_CHARS}文字を超えています(${markdown.length}文字)`,
    );
  }

  for (const block of splitIntoBlocks(markdown)) {
    if (!block.every(isProseLine)) {
      continue;
    }
    const text = block.join("");
    const sentences = text.split("。").filter((s) => s.trim() !== "");
    if (sentences.length > MAX_SENTENCES_PER_PARAGRAPH) {
      issues.push(
        `段落の文数が${MAX_SENTENCES_PER_PARAGRAPH}文を超えています(${sentences.length}文): 「${text.slice(0, 40)}...」`,
      );
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// 図の参照
// ---------------------------------------------------------------------------

const DIAGRAM_FILE_NAME_PATTERN = /^(.+)\.drawio$/;

/**
 * `markdown`の`![name](name.drawio)`の参照と`diagramFiles`
 * (文書と一緒に実際に書き出された`.drawio`ファイル)が、双方向に対応するかを検査する。
 * あわせて、図のファイル名がすべて`[a-z0-9-]{1,64}`に従うことと、
 * 図の数が`MAX_DIAGRAMS`を超えないことも確かめる。
 */
export function checkDiagramRefs(
  markdown: string,
  diagramFiles: readonly string[],
): string[] {
  const issues: string[] = [];

  const referencedNames = new Set<string>();
  for (const match of markdown.matchAll(DIAGRAM_REF_PATTERN)) {
    referencedNames.add(match[1] ?? "");
  }

  const fileNames = new Set<string>();
  for (const fileName of diagramFiles) {
    const nameMatch = fileName.match(DIAGRAM_FILE_NAME_PATTERN);
    if (nameMatch === null) {
      issues.push(`図ファイル名が.drawio拡張子ではありません: ${fileName}`);
      continue;
    }
    const name = nameMatch[1] ?? "";
    if (!DIAGRAM_NAME_PATTERN.test(name)) {
      issues.push(
        `図の名前の形式が不正です: ${fileName}(小文字英数字とハイフンのみ、64文字以内にしてください)`,
      );
    }
    fileNames.add(name);
  }

  for (const name of referencedNames) {
    if (!fileNames.has(name)) {
      issues.push(`本文が参照する図「${name}」に対応するファイルがありません`);
    }
  }
  for (const name of fileNames) {
    if (!referencedNames.has(name)) {
      issues.push(`図ファイル「${name}.drawio」が本文から参照されていません`);
    }
  }

  if (referencedNames.size > MAX_DIAGRAMS) {
    issues.push(
      `図の数が上限(${MAX_DIAGRAMS}枚)を超えています(${referencedNames.size}枚)`,
    );
  }

  return issues;
}

// ---------------------------------------------------------------------------
// 集約
// ---------------------------------------------------------------------------

export type RequirementsDocValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: string[] };

/** `markdown`を`rules`で検査し、`rule`の問題だけを「N行目: 内容」の形で返す。 */
function documentProseIssues(
  markdown: string,
  rule: ProseRuleId,
  rules: ProseRules = REPORT_RULES,
): string[] {
  return formatProseIssues(
    checkProse(markdown, rules).filter((issue) => issue.rule === rule),
  );
}

/**
 * 要件定義書と監査レポートの文章のうち、生成を失敗にする規則
 * (見出しにコード表記を入れない)で検査する。
 * 絵文字と太字は`checkForbiddenSyntax`が見るので、ここでは見ない。
 * 文体は`documentRegisterIssues`が見る。
 */
export function checkDocumentProse(markdown: string): string[] {
  return documentProseIssues(markdown, "heading-code");
}

/**
 * 生成した文書の文体を検査する。既定は常体(要件定義書と監査レポート)で、
 * GitHubに投稿して人が読む文章(監査の改善提案)は`"polite"`を渡して敬体で検査する。
 * 呼び出し側は問題をログに残すだけにし、生成を失敗にしない。
 * 引用符の無い画面の文言や注記の別の文体でも当たるので、これで生成全体をやり直すと、
 * 費用に見合わないためである。
 */
export function documentRegisterIssues(
  markdown: string,
  register: ProseRegister = "plain",
): string[] {
  return documentProseIssues(markdown, "register", {
    ...REPORT_RULES,
    register,
  });
}

/** 書き終えた要件定義書にすべての検査をかけ、結果を1つの判定にまとめる。 */
export function validateRequirementsDoc(
  markdown: string,
  diagramFiles: readonly string[],
): RequirementsDocValidation {
  const issues = [
    ...checkSections(markdown),
    ...checkRequirementIds(markdown),
    ...checkForbiddenSyntax(markdown),
    ...checkQuotes(markdown),
    ...checkLengths(markdown),
    ...checkDocumentProse(markdown),
    ...checkDiagramRefs(markdown, diagramFiles),
  ];
  if (issues.length === 0) {
    return { ok: true };
  }
  return { ok: false, issues };
}
