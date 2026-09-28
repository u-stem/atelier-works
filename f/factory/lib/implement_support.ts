// Pure helpers for the implement flow's Claude output (工程3 design §6):
// the structured-output shape guard `runClaude` needs, the semantic check
// the flow applies before committing, and the commit-message assembly.
// No I/O here; every function is exported for unit testing
// (tests/lib/implement_support.test.ts). Kept in lib — not in
// steps/pr_workflow_support.ts, which is pr_review/pr_fix-specific — so the
// implement steps (added later) share it without a lib -> steps import.
//
// Shape vs. semantics are split on purpose: `isImplementClaudeOutput`
// mirrors prompts.ts's IMPLEMENT_SCHEMA field by field (what `claude -p
// --json-schema` already enforces), while `validateImplementOutput` holds
// the rules the schema cannot express (gap_report required on a gap, a
// committable subject on done). The implement_generate step (added later)
// composes them as `runClaude`'s `isStructuredOutput` so a semantic miss
// also gets claude.ts's single "fill the required fields" retry.

import { isOneOf, isRecord, isString, isStringArray } from "./types.ts";

/** Claude's own two outcomes (IMPLEMENT_SCHEMA). The verify loop's extra
 * `implement_rounds.outcome` values (`check_failed` / `checks_skipped` /
 * `stalled` / `error`, types.ts's ImplementRoundOutcome) are the flow's,
 * never Claude's. */
export type ImplementClaudeOutcome = "done" | "requirements_gap";
export const IMPLEMENT_CLAUDE_OUTCOMES: readonly ImplementClaudeOutcome[] = [
  "done",
  "requirements_gap",
];

export type ImplementClaudeOutput = {
  readonly outcome: ImplementClaudeOutcome;
  readonly summary: string;
  /** Required (non-null, non-blank) when `outcome` is "requirements_gap";
   * becomes the feedback for 工程2's attempt+1 (design §1). */
  readonly gap_report: string | null;
  /** Non-empty single line when `outcome` is "done"; `""` otherwise. */
  readonly commit_subject: string;
  /** Optional body; `""` means none (IMPLEMENT_SCHEMA is not nullable
   * here, unlike FIX_SCHEMA's `commit_body`). */
  readonly commit_body: string;
  /** Judgment calls, protected-path changes, unwritable paths — rendered
   * into the PR body's 確認して欲しい点 (design §7). */
  readonly notes_for_reviewer: string[];
};

/** Matches prompts.ts's IMPLEMENT_SCHEMA exactly (the schema passed to
 * `claude -p --json-schema`). Shape only — see `validateImplementOutput`
 * for the outcome-dependent rules. */
export function isImplementClaudeOutput(
  value: unknown,
): value is ImplementClaudeOutput {
  if (!isRecord(value)) return false;
  if (!isOneOf(value.outcome, IMPLEMENT_CLAUDE_OUTCOMES)) return false;
  if (!isString(value.summary)) return false;
  if (value.gap_report !== null && !isString(value.gap_report)) return false;
  if (!isString(value.commit_subject)) return false;
  if (!isString(value.commit_body)) return false;
  return isStringArray(value.notes_for_reviewer);
}
