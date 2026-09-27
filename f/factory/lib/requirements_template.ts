// Fixed definitions for the requirements-writing template
// (.claude/skills/factory-requirements/template.md), which is the single
// source of truth for both the headless Claude prompt (factory-requirements
// SKILL.md) and the machine validation in requirements_doc.ts. Keeping the
// section list, ID patterns, and size limits here means the template and
// the validator can't drift silently apart —
// tests/lib/requirements_template.test.ts asserts the template's actual
// `##` headings match REQUIREMENTS_SECTIONS.
//
// Wired into pipeline_generate.ts / prompts.ts / the DB (see
// docs/architecture.md, 工程2); Console inline diagram rendering from the
// doc dir is a follow-up PR.

import { assertGitHubName } from "./types.ts";

/**
 * The fixed `##` section headings of the requirements template, in order.
 * `requirements_doc.ts`'s `checkSections` compares a generated document's
 * headings against this list, order included.
 */
export const REQUIREMENTS_SECTIONS: readonly string[] = [
  "背景・目的",
  "スコープ",
  "用語",
  "利用者と利用シーン",
  "業務要件",
  "機能要件",
  "非機能要件",
  "制約・前提",
  "受入条件",
  "未決事項",
  "変更履歴",
];

/** ID formats for the 機能要件 / 非機能要件 / 受入条件 tables. */
export const REQUIREMENT_ID_PATTERNS: {
  readonly FR: RegExp;
  readonly NFR: RegExp;
  readonly AC: RegExp;
} = {
  FR: /^FR-\d{3}$/,
  NFR: /^NFR-\d{3}$/,
  AC: /^AC-\d{3}$/,
};

/** Soft ceiling on total document length (title + tables included). */
export const MAX_DOC_CHARS = 8000;

/** Soft ceiling on a single line's length. */
export const MAX_LINE_CHARS = 200;

/** Maximum number of diagrams a single requirements document may embed. */
export const MAX_DIAGRAMS = 3;

/** Maximum number of `。`-delimited sentences per prose paragraph. */
export const MAX_SENTENCES_PER_PARAGRAPH = 3;

/** Diagram file / name format: lowercase alphanumeric and hyphens only. */
export const DIAGRAM_NAME_PATTERN = /^[a-z0-9-]{1,64}$/;

/**
 * Matches an embedded diagram reference `![name](name.drawio)` in the
 * document body. The backreference (`\1`) requires the link text and the
 * file name to be the same string, per the drawio-diagram skill's naming
 * rule (図名 = ファイル名 = 本文の参照).
 */
export const DIAGRAM_REF_PATTERN = /!\[([a-z0-9-]{1,64})\]\(\1\.drawio\)/g;

/** Path to the single source-of-truth template, relative to repo root. */
export const TEMPLATE_RELATIVE_PATH =
  ".claude/skills/factory-requirements/template.md";

/** Base directory under which generated requirements documents are stored
 * — a worker-only volume (see docs/architecture.md, 工程2). */
export const REQUIREMENTS_BASE_DIR = "/var/lib/factory/requirements";

/**
 * Builds the directory a requirements document (and any diagrams alongside
 * it) for one generation attempt is written to:
 * `<base>/<owner>/<repo>/issue-<issueNumber>/wi-<workItemId>/attempt-<attempt>`.
 *
 * `owner` / `repo` are validated with `assertGitHubName` (throws on an
 * invalid GitHub login/repository name) before being interpolated into the
 * path, since they ultimately come from GitHub webhook/API data.
 */
export function buildRequirementsDocDir(
  base: string,
  owner: string,
  repo: string,
  issueNumber: number,
  workItemId: number,
  attempt: number,
): string {
  assertGitHubName(owner);
  assertGitHubName(repo);
  const numericParts: readonly (readonly [string, number])[] = [
    ["issueNumber", issueNumber],
    ["workItemId", workItemId],
    ["attempt", attempt],
  ];
  for (const [label, value] of numericParts) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(
        `buildRequirementsDocDir: ${label} must be a non-negative integer (got ${String(value)})`,
      );
    }
  }
  return `${base}/${owner}/${repo}/issue-${String(issueNumber)}/wi-${String(workItemId)}/attempt-${String(attempt)}`;
}
