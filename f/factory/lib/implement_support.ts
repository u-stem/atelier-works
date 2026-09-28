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
// committable subject on done). The implement steps call
// `validateImplementOutput` after `runClaude` succeeds and record `reason`
// on the implement round before treating it as a fix round.

import { isOneOf, isRecord, isString, isStringArray } from "./types.ts";
import { withCommitTrailers } from "./workspace.ts";

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

// ---------------------------------------------------------------------------
// validateImplementOutput: the outcome-dependent rules IMPLEMENT_SCHEMA
// cannot express
// ---------------------------------------------------------------------------

/** git's subject-line convention, the same ceiling pr_workflow_support.ts
 * applies to pr_fix's `commit_subject`; the prompt asks Claude to aim for
 * about 50 so a slightly long subject does not waste a whole run. */
export const COMMIT_SUBJECT_MAX_CODEPOINTS = 72;

export type ImplementOutputValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * `requirements_gap` needs a non-blank `gap_report` (it becomes 工程2's
 * feedback — an empty one would restart requirements generation with
 * nothing to act on) and, mirroring the promise the skill and the prompt
 * both make Claude, an empty `commit_subject`/`commit_body` (there is no
 * commit to describe). `done` needs a committable `commit_subject`,
 * judged on its trimmed value: non-blank, single-line, at most
 * `COMMIT_SUBJECT_MAX_CODEPOINTS` code points (counted by spreading, not
 * `.length`), not ending in "…" (a sign Claude tried to write past the
 * limit instead of within it — same reasoning as
 * pr_workflow_support.ts's isValidCommitSubject), and free of control
 * characters other than the already-rejected newline; it also requires a
 * `null` `gap_report` (same skill/prompt promise, the other direction).
 * `commit_body` is otherwise free-form and never rejected on its own
 * content. `reason` is operator-facing English, recorded on the
 * implement_rounds row / job log, never shown to Claude.
 */
export function validateImplementOutput(
  output: ImplementClaudeOutput,
): ImplementOutputValidation {
  if (output.outcome === "requirements_gap") {
    if (output.gap_report === null || output.gap_report.trim().length === 0) {
      return {
        ok: false,
        reason: "requirements_gap outcome without a gap_report",
      };
    }
    if (output.commit_subject !== "" || output.commit_body !== "") {
      return {
        ok: false,
        reason:
          "commit_subject and commit_body must be empty when outcome is not done",
      };
    }
    return { ok: true };
  }
  if (output.gap_report !== null) {
    return {
      ok: false,
      reason: "gap_report must be null when outcome is done",
    };
  }
  const subject = output.commit_subject.trim();
  if (subject.length === 0) {
    return { ok: false, reason: "done outcome with an empty commit_subject" };
  }
  if (subject.includes("\n")) {
    return { ok: false, reason: "commit_subject contains a newline" };
  }
  if ([...subject].length > COMMIT_SUBJECT_MAX_CODEPOINTS) {
    return {
      ok: false,
      reason: `commit_subject exceeds ${String(COMMIT_SUBJECT_MAX_CODEPOINTS)} code points`,
    };
  }
  if (subject.endsWith("…")) {
    return { ok: false, reason: 'commit_subject ends with "…"' };
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching control characters (except \n, already rejected above), to reject them
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(subject)) {
    return {
      ok: false,
      reason: "commit_subject must not contain control characters",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// buildImplementCommitMessage: subject + body + trailers (design §7)
// ---------------------------------------------------------------------------

/**
 * The literal commit message `implement_finish` passes to `commitAndPush`
 * (workspace.ts): the trimmed `commit_subject`, then — only when
 * `commit_body` is not blank — a blank line and the trimmed body, then the
 * `Co-Authored-By` / `Generated-By` trailers via `withCommitTrailers`
 * (idempotent, so `commitAndPush`'s own call adds nothing more). Callers
 * run `validateImplementOutput` first; this function does not re-check the
 * subject. Japanese spacing normalization (`normalizeJapaneseText`, a
 * steps/pr_workflow_support.ts export) is the caller's job before this —
 * lib does not import from steps.
 */
export function buildImplementCommitMessage(
  output: Pick<ImplementClaudeOutput, "commit_subject" | "commit_body">,
  instanceName: string,
): string {
  const subject = output.commit_subject.trim();
  const body = output.commit_body.trim();
  const message = body.length === 0 ? subject : `${subject}\n\n${body}`;
  return withCommitTrailers(message, instanceName);
}
