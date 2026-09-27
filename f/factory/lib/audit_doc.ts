// Machine validation for a filled-in audit report (see
// .claude/skills/factory-audit/template.md and SKILL.md) and for the
// structured output (summary + improvement proposals) headless Claude
// produces alongside it. Every function here is a pure function over
// markdown text / plain data — no I/O, no Windmill/GitHub dependency — so
// headless Claude's output can be checked the same way in a unit test as
// it is wired into the audit pipeline (工程5, see docs/architecture.md).
//
// Each `check*` function returns a list of Japanese-language issue strings
// (empty when there's nothing to report); `validateAuditReport` aggregates
// the report-level checks into a single ok/issues result, and
// `checkAuditOutput` separately validates the structured output.

import {
  checkForbiddenSyntax,
  checkLengths,
  extractH2Headings,
} from "./requirements_doc.ts";

/** Base directory under which generated audit reports are stored — a
 * worker-only volume (see docs/architecture.md, 工程5). */
export const AUDIT_BASE_DIR = "/var/lib/factory/audits";

/** Path to the single source-of-truth template, relative to repo root. */
export const AUDIT_TEMPLATE_RELATIVE_PATH =
  ".claude/skills/factory-audit/template.md";

/** File name of the generated audit report within its directory. */
export const REPORT_MD_FILENAME = "report.md";

/** File name of the collected evidence pack within its directory. */
export const EVIDENCE_MD_FILENAME = "evidence.md";

/**
 * The fixed `##` section headings of the audit report template, in order.
 * `checkAuditSections` compares a generated document's headings against
 * this list, order included.
 */
export const AUDIT_SECTIONS: readonly string[] = [
  "対象期間と要約",
  "実行状況",
  "失敗と要人手",
  "承認の傾向",
  "改善提案",
  "見送った論点",
];

/** One improvement proposal from the audit's structured output — its
 * title must match a row of the report's 改善提案 table. */
export type AuditProposal = { readonly title: string; readonly body: string };

const MAX_SUMMARY_CHARS = 200;
const MAX_TITLE_CHARS = 80;
const MAX_BODY_CHARS = 3000;
const MAX_PROPOSALS = 5;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/;
const HTML_COMMENT_GLOBAL_PATTERN = /<!--[\s\S]*?-->/g;
const URL_PATTERN = /https?:\/\/[^\s)>"']+/g;

/**
 * Removes HTML comments from `text` before it's passed to
 * `checkForbiddenSyntax`: an HTML comment also happens to match that
 * check's "leftover HTML tag / unfilled placeholder" pattern (both start
 * with `<` and end at the next `>`), so without stripping it first, a
 * single comment would be reported twice — once by `checkHtmlComments`,
 * once by `checkForbiddenSyntax` — for the same underlying issue.
 */
function stripHtmlComments(text: string): string {
  return text.replace(HTML_COMMENT_GLOBAL_PATTERN, "");
}

/**
 * Checks that `markdown`'s `##` headings are exactly `AUDIT_SECTIONS`, in
 * the same order.
 */
export function checkAuditSections(markdown: string): string[] {
  const headings = extractH2Headings(markdown);
  const inOrder =
    headings.length === AUDIT_SECTIONS.length &&
    headings.every((heading, index) => heading === AUDIT_SECTIONS[index]);
  if (inOrder) {
    return [];
  }
  return [
    `章立てがテンプレートと一致しません(期待: ${AUDIT_SECTIONS.join(" / ")}、実際: ${headings.join(" / ")})`,
  ];
}

/** Detects a leftover HTML comment (e.g. an internal marker such as
 * `<!-- factory:issue_proposal:1 -->` that must not leak into the report
 * or structured output). */
export function checkHtmlComments(text: string): string[] {
  return HTML_COMMENT_PATTERN.test(text)
    ? ["HTMLコメントが含まれています"]
    : [];
}

const H2_HEADING_PATTERN = /^##\s+(.*\S)\s*$/;

/** Returns the body lines of the `##`-level section named `heading` (the
 * lines between its heading and the next `##` heading, or end of
 * document), or `null` if no such heading exists. */
function sectionBody(markdown: string, heading: string): string | null {
  const lines = markdown.split("\n");
  const start = lines.findIndex(
    (line) => line.match(H2_HEADING_PATTERN)?.[1] === heading,
  );
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((line) => /^##\s/.test(line));
  return (next < 0 ? rest : rest.slice(0, next)).join("\n");
}

/**
 * Reads the title column of the 改善提案 section's table, in row order.
 * Returns `[]` when the section's body is just "該当なし" (no proposals
 * this period), and `null` when the section is missing or its table can't
 * be parsed (fewer than a header + separator + one data row).
 */
export function extractProposalTitles(markdown: string): string[] | null {
  const body = sectionBody(markdown, "改善提案");
  if (body === null) return null;
  if (body.trim() === "該当なし") return [];
  const rows = body.split("\n").filter((line) => line.trim().startsWith("|"));
  if (rows.length < 3) return null;
  return rows.slice(2).map((row) => {
    const cells = row.split("|").map((cell) => cell.trim());
    return cells[2] ?? "";
  });
}

/**
 * Checks that the report's 改善提案 table lists exactly the same titles
 * (as a set, regardless of order) as the structured output's `proposals`.
 */
export function checkProposalTable(
  markdown: string,
  proposals: readonly AuditProposal[],
): string[] {
  const titles = extractProposalTitles(markdown);
  if (titles === null) return ["改善提案の表が読めません"];
  const expected = [...proposals.map((p) => p.title)].sort();
  const actual = [...titles].sort();
  const matches =
    expected.length === actual.length &&
    expected.every((title, index) => title === actual[index]);
  if (!matches) {
    return [
      `改善提案の表(${actual.length}件)と構造化出力(${expected.length}件)のタイトルが一致しません`,
    ];
  }
  return [];
}

export type AuditReportValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: string[] };

/** Runs every report-level check and aggregates the results into a single
 * ok/issues verdict for a filled-in audit report. */
export function validateAuditReport(
  markdown: string,
  proposals: readonly AuditProposal[],
): AuditReportValidation {
  const issues = [
    ...checkAuditSections(markdown),
    ...checkForbiddenSyntax(stripHtmlComments(markdown)),
    ...checkHtmlComments(markdown),
    ...checkLengths(markdown),
    ...checkProposalTable(markdown, proposals),
  ];
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/**
 * Validates the audit's structured output (summary + proposals): summary
 * length, per-proposal title/body length, duplicate titles, proposal
 * count, HTML comments, `checkForbiddenSyntax`'s AI-writing-habit checks,
 * and that every URL in a proposal starts with one of
 * `allowedUrlPrefixes` (e.g. this repository's GitHub URL, so the model
 * can't point elsewhere).
 */
export function checkAuditOutput(
  output: {
    readonly summary: string;
    readonly proposals: readonly AuditProposal[];
  },
  allowedUrlPrefixes: readonly string[],
): string[] {
  const issues: string[] = [];
  if (output.summary.length > MAX_SUMMARY_CHARS) {
    issues.push(`summaryが${MAX_SUMMARY_CHARS}字を超えています`);
  }
  if (output.proposals.length > MAX_PROPOSALS) {
    issues.push(`提案が${MAX_PROPOSALS}件を超えています`);
  }
  const seen = new Set<string>();
  output.proposals.forEach((proposal, index) => {
    const label = `提案${index + 1}`;
    if (
      proposal.title.trim().length === 0 ||
      proposal.title.length > MAX_TITLE_CHARS
    ) {
      issues.push(`${label}のtitleが空か${MAX_TITLE_CHARS}字を超えています`);
    }
    if (proposal.body.length > MAX_BODY_CHARS) {
      issues.push(`${label}のbodyが${MAX_BODY_CHARS}字を超えています`);
    }
    if (seen.has(proposal.title)) {
      issues.push(`${label}のtitleが重複しています`);
    }
    seen.add(proposal.title);
    const text = `${proposal.title}\n${proposal.body}`;
    issues.push(
      ...checkHtmlComments(text).map((issue) => `${label}: ${issue}`),
    );
    issues.push(
      ...checkForbiddenSyntax(stripHtmlComments(text)).map(
        (issue) => `${label}: ${issue}`,
      ),
    );
    for (const url of text.match(URL_PATTERN) ?? []) {
      if (!allowedUrlPrefixes.some((prefix) => url.startsWith(prefix))) {
        issues.push(`${label}に許可されていないURLが含まれています`);
      }
    }
  });
  return issues;
}
