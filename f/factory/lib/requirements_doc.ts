// Machine validation for a filled-in requirements document (see
// .claude/skills/factory-requirements/template.md and SKILL.md). Every
// function here is a pure function over markdown text — no I/O, no
// Windmill/GitHub dependency — so headless Claude's output can be checked
// the same way in a unit test as it is wired into the pipeline
// (steps/pipeline_generate.ts's post-generation validation; see
// docs/architecture.md, 工程2).
//
// Each `check*` function returns a list of Japanese-language issue strings
// (empty when there's nothing to report); `validateRequirementsDoc`
// aggregates all of them into a single ok/issues result.

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
// Headings
// ---------------------------------------------------------------------------

const H2_HEADING_PATTERN = /^##\s+(.*\S)\s*$/;

/**
 * Extracts every `##` (exactly two, not `###`+) heading's text, in the
 * order they appear in `markdown`. Code fences are not special-cased: the
 * document is never expected to contain one (see `checkForbiddenSyntax`),
 * so a `##`-looking line inside a fence would itself be a bug to surface,
 * not something to silently skip.
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
 * Checks that `markdown`'s `##` headings are exactly `REQUIREMENTS_SECTIONS`,
 * in the same order — missing, extra, and out-of-order headings are each
 * reported distinctly.
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
// Markdown table parsing (shared by checkRequirementIds / checkDiagramRefs)
// ---------------------------------------------------------------------------

function extractSectionBody(markdown: string, heading: string): string {
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

/** Parses every `| a | b |` table in `body`, returning only the data rows
 * (header and separator rows are dropped). Cell values are trimmed. */
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
// Requirement / acceptance-criteria IDs
// ---------------------------------------------------------------------------

type IdKind = keyof typeof REQUIREMENT_ID_PATTERNS;

/** Validates one ID column (format, duplicates, no-gap numbering from 001)
 * and returns the well-formed, unique IDs found (in table order). */
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
 * Validates the FR / NFR / AC ID columns in 機能要件 / 非機能要件 / 受入条件:
 * format, uniqueness, no-gap numbering from 001, that every 受入条件's
 * 対象要件 points at an existing FR, and that every FR has at least one
 * 受入条件 referencing it.
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
// Forbidden syntax (AI writing habits the skill explicitly bans)
// ---------------------------------------------------------------------------

const CODE_FENCE_PATTERN = /```/;
const BOLD_PATTERN = /\*\*/;
const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;
// Excludes markdown autolinks (`<https://...>` / `<http://...>`), which are
// valid syntax, not a leftover HTML tag or unfilled `<...>` placeholder.
const HTML_TAG_OR_PLACEHOLDER_PATTERN = /<(?!https?:\/\/)[^<>\n]+>/g;
const ALERT_LINE_PATTERN = /^>\s*\[!([A-Za-z]+)\]/;
const ALLOWED_ALERT_KINDS = new Set(["NOTE", "WARNING", "IMPORTANT"]);

/**
 * Detects the AI writing habits the requirements skill explicitly forbids:
 * code fences, `**` bold, emoji, leftover HTML tags/unfilled `<...>`
 * placeholders, and alert callouts other than
 * `[!NOTE]` / `[!WARNING]` / `[!IMPORTANT]`.
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
// Quotes / alert callouts
// ---------------------------------------------------------------------------

const EMPTY_QUOTE_LINE_PATTERN = /^>\s*$/;
const QUOTE_CONTENT_LINE_PATTERN = /^>\s*\S/;

/**
 * Checks that block quotes carry actual content: no bare `>` line with
 * nothing after it, and every `> [!KIND]` alert heading is immediately
 * followed by a non-empty `>`-prefixed body line.
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
// Length / paragraph density
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

/** Groups `markdown`'s lines into blank-line-separated blocks. */
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
 * Checks per-line length, total document length, and per-paragraph
 * sentence count (`。`-delimited; tables/headings/quotes/lists/diagram
 * embeds are excluded from the paragraph check).
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
// Diagram references
// ---------------------------------------------------------------------------

const DIAGRAM_FILE_NAME_PATTERN = /^(.+)\.drawio$/;

/**
 * Checks that `markdown`'s `![name](name.drawio)` references and
 * `diagramFiles` (the `.drawio` files actually written alongside the
 * document) match up in both directions, that every diagram file name is
 * `[a-z0-9-]{1,64}`, and that the diagram count doesn't exceed
 * `MAX_DIAGRAMS`.
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
// Aggregate
// ---------------------------------------------------------------------------

export type RequirementsDocValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: string[] };

/** Runs every check and aggregates the results into a single ok/issues
 * verdict for a filled-in requirements document. */
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
    ...checkDiagramRefs(markdown, diagramFiles),
  ];
  if (issues.length === 0) {
    return { ok: true };
  }
  return { ok: false, issues };
}
