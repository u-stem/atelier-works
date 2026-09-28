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

import { createHash } from "node:crypto";
import {
  IMPLEMENT_PROTECTED_PATH_PREFIXES,
  matchesForbiddenPath,
} from "./protected_paths.ts";
import { extractSectionBody } from "./requirements_doc.ts";
import {
  assertBranchName,
  isOneOf,
  isRecord,
  isString,
  isStringArray,
} from "./types.ts";
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

// ---------------------------------------------------------------------------
// buildImplementBranchName: `factory/issue-<N>-wi-<id>` (design §7)
// ---------------------------------------------------------------------------

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `buildImplementBranchName: ${label} must be a positive integer, got ${String(value)}`,
    );
  }
}

/** The implement branch for one work item. Both numbers come from the DB
 * (never user text), but the result still goes through `assertBranchName`
 * so a future caller cannot hand git something it would read as a flag. */
export function buildImplementBranchName(
  issueNumber: number,
  workItemId: number,
): string {
  assertPositiveInteger(issueNumber, "issueNumber");
  assertPositiveInteger(workItemId, "workItemId");
  const branch = `factory/issue-${String(issueNumber)}-wi-${String(workItemId)}`;
  assertBranchName(branch);
  return branch;
}

// ---------------------------------------------------------------------------
// classifyProtectedChanges: record (never block) protected-path changes
// (design §3, §0b)
// ---------------------------------------------------------------------------

export type ProtectedChangeFlags = {
  /** steps/pr_workflow_support.ts's packageJsonScriptsChanged, computed by the caller. */
  readonly packageJsonScriptsChanged: boolean;
  /** Repo-relative paths of newly added `*.sh` files (the caller filters
   * its ChangedPath list through protected_paths.ts's isNewShellScript). */
  readonly newShellScripts: readonly string[];
};

/**
 * One human-facing Japanese line per protected change in the diff, using
 * the implement flow's prefix list (`IMPLEMENT_PROTECTED_PATH_PREFIXES`,
 * which includes `infra/**`). Unlike pr_fix's detectForbiddenChanges this
 * never blocks: the result is stored on the implement round, listed in the
 * PR body's 確認して欲しい点 and the Discord pr_opened notification, and
 * makes implement_verify skip the check commands for that round.
 */
export function classifyProtectedChanges(
  changedPaths: readonly string[],
  flags: ProtectedChangeFlags,
): string[] {
  const reasons: string[] = [];
  for (const path of changedPaths) {
    if (matchesForbiddenPath(path, IMPLEMENT_PROTECTED_PATH_PREFIXES)) {
      reasons.push(`保護パスを変更: ${path}`);
    }
  }
  for (const path of flags.newShellScripts) {
    reasons.push(`新規の*.shを追加: ${path}`);
  }
  if (flags.packageJsonScriptsChanged) {
    reasons.push("package.jsonのscriptsを変更");
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// truncateCheckOutput: `implement_rounds.check_output` keeps the first 16KB
// (design §5; §12 hand-off asks for a UTF-8-boundary-safe cut)
// ---------------------------------------------------------------------------

export const CHECK_OUTPUT_MAX_BYTES = 16 * 1024;

/** Whether `byte` is a UTF-8 continuation byte (`10xxxxxx`). */
function isContinuationByte(byte: number): boolean {
  return (byte & 0b1100_0000) === 0b1000_0000;
}

/**
 * The first `maxBytes` bytes of `text` as valid UTF-8 text: when the byte
 * boundary would split a multi-byte character, the whole character is
 * dropped instead. Measured in bytes (the column's intended limit), not
 * UTF-16 code units. Callers pass the check commands' combined output
 * before `insertImplementRound`; the prompt-side tail is separate
 * (runAllowedCheckCommands's outputTail).
 */
export function truncateCheckOutput(
  text: string,
  maxBytes: number = CHECK_OUTPUT_MAX_BYTES,
): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && isContinuationByte(bytes[end] ?? 0)) {
    end -= 1;
  }
  return new TextDecoder().decode(bytes.subarray(0, end));
}

// ---------------------------------------------------------------------------
// buildImplementPrBody: .github/PULL_REQUEST_TEMPLATE.md's sections filled
// from the round's results (design §7)
// ---------------------------------------------------------------------------

export const NO_ACCEPTANCE_CRITERIA_NOTE =
  "(要件定義に受入条件の節がありません)";

const ACCEPTANCE_CRITERIA_HEADING = "受入条件";

/** The approved requirements document's `## 受入条件` body, verbatim, for
 * the PR body's 受入条件 section — or a fixed note when the section is
 * missing or empty (the requirements validator rejects such a document,
 * but the PR body must never silently render an empty section). */
export function extractAcceptanceCriteria(markdown: string): string {
  const body = extractSectionBody(markdown, ACCEPTANCE_CRITERIA_HEADING).trim();
  return body.length === 0 ? NO_ACCEPTANCE_CRITERIA_NOTE : body;
}

export type DeployNeeds = {
  /** `infra/**` changed — worker image rebuild (host-side `mise run deploy`). */
  readonly imageRebuild: boolean;
  /** `migrations/**` changed — `wmill datatable migrate up`. */
  readonly migrate: boolean;
  /** `f/**` changed — `wmill sync push`. */
  readonly syncPush: boolean;
};

/** Mechanical reading of the template's 備考 checklist from the diff's
 * paths. Only meaningful for the factory repo itself: another repo may well
 * have its own `infra/`, `migrations/` or `f/` directories, so the flags
 * would be set for paths that have nothing to do with Windmill. The caller
 * gates it with ImplementPrBodyInput's `deployChecklist`. */
export function classifyDeployNeeds(
  changedPaths: readonly string[],
): DeployNeeds {
  return {
    imageRebuild: changedPaths.some((path) => path.startsWith("infra/")),
    migrate: changedPaths.some((path) => path.startsWith("migrations/")),
    syncPush: changedPaths.some((path) => path.startsWith("f/")),
  };
}

export type ImplementCheckSummary =
  | {
      readonly kind: "ran";
      readonly results: readonly {
        readonly command: string;
        readonly ok: boolean;
      }[];
    }
  | { readonly kind: "skipped"; readonly reason: string };

export type ImplementPrBodyInput = {
  /** Claude's `summary` (caller applies normalizeJapaneseText first). */
  readonly summary: string;
  /** The approved requirements document (requirement_drafts markdown). */
  readonly requirementsMarkdown: string;
  /** The final round's checks. */
  readonly checks: ImplementCheckSummary;
  /** classifyProtectedChanges's lines for the final diff. */
  readonly protectedChanges: readonly string[];
  /** Claude's `notes_for_reviewer` (caller normalizes first). */
  readonly notesForReviewer: readonly string[];
  /** approval_support.ts's buildConsoleUrl(url, { work_item_id }). */
  readonly requirementsConsoleUrl: string;
  readonly issueNumber: number;
  readonly changedPaths: readonly string[];
  /** true when the target repo is the factory itself (the caller decides):
   * only then does 備考 carry the Windmill deploy checklist; otherwise it
   * reads なし. */
  readonly deployChecklist: boolean;
};

/*
 * Sanitisers for Claude-authored text in the PR body. That text is
 * untrusted-influenced (Claude reads the issue and the repository), and the
 * body is both rendered by GitHub and parsed by the factory itself, so three
 * threats are neutralised:
 * - heading / HTML-block injection: a `#` heading, a setext underline or a
 *   raw `<` (`<!--`, `<details>`, ...) could open a new section, hide text
 *   or restructure the template's sections;
 * - closing-keyword hijack: `fixes #5` would make GitHub close issue #5 on
 *   merge and make poll_prs's extractLinkedIssueNumbers link the PR to the
 *   wrong issue, so every `#<digit>` is escaped (the real `Closes #N` is
 *   written by buildImplementPrBody itself, outside the sanitised text);
 * - mentions: `@user` / `@org/team` would notify people.
 * A backslash is inserted before the offending character (GitHub renders
 * `\#`, `\<`, `\@` as the literal character). A character already
 * escaped by an odd run of backslashes is left alone, so our own escapes are
 * never doubled into `\\#` (which would re-activate the character).
 */

const ATX_HEADING_LINE = /^(\s{0,3})#/;
const SETEXT_UNDERLINE_LINE = /^(\s{0,3})(=+|-+)\s*$/;
const MENTION_START = /^[A-Za-z0-9_]$/;
const DIGIT = /^[0-9]$/;

function needsInlineEscape(char: string, next: string): boolean {
  if (char === "<") return true;
  if (char === "#") return DIGIT.test(next);
  if (char === "@") return MENTION_START.test(next);
  return false;
}

/** Inserts `\` before every `<`, `#<digit>` and `@<word char>` that is not
 * already escaped (preceded by an odd number of backslashes). */
function escapeInlineTriggers(text: string): string {
  let out = "";
  let backslashes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (
      char !== "\\" &&
      backslashes % 2 === 0 &&
      needsInlineEscape(char, text.charAt(i + 1))
    ) {
      out += "\\";
    }
    out += char;
    backslashes = char === "\\" ? backslashes + 1 : 0;
  }
  return out;
}

function escapeBlockLine(line: string): string {
  if (ATX_HEADING_LINE.test(line)) {
    return line.replace(ATX_HEADING_LINE, "$1\\#");
  }
  if (SETEXT_UNDERLINE_LINE.test(line)) {
    return line.replace(/^(\s{0,3})([=-])/, "$1\\$2");
  }
  return line;
}

/** For multi-line Claude-authored prose (the summary): strips `\r`, escapes
 * ATX heading and setext underline lines, then `<`, `#<digit>` and
 * `@<word char>` anywhere in the text. */
export function sanitizePrProse(text: string): string {
  const blockSafe = text
    .replaceAll("\r", "")
    .split("\n")
    .map(escapeBlockLine)
    .join("\n");
  return escapeInlineTriggers(blockSafe);
}

/** For a single-line list item (a reviewer note, a protected-change line):
 * collapses every whitespace run containing a newline into one space so the
 * item cannot spill onto new lines, trims, then applies sanitizePrProse. */
export function sanitizePrLine(text: string): string {
  return sanitizePrProse(text.replace(/\s*\n\s*/g, " ").trim());
}

function checkbox(checked: boolean, label: string): string {
  return `- [${checked ? "x" : " "}] ${label}`;
}

function renderDeployChecklist(changedPaths: readonly string[]): string[] {
  const needs = classifyDeployNeeds(changedPaths);
  const nothingNeeded =
    !needs.imageRebuild && !needs.migrate && !needs.syncPush;
  return [
    "Windmillへの反映の要否:",
    "",
    checkbox(needs.syncPush, "`wmill sync push`が必要"),
    checkbox(needs.migrate, "`wmill datatable migrate up`が必要"),
    checkbox(needs.imageRebuild, "worker imageのrebuildが必要"),
    checkbox(nothingNeeded, "上記いずれも不要"),
  ];
}

function renderChecks(checks: ImplementCheckSummary): string {
  if (checks.kind === "skipped") {
    return `検査未実施: ${checks.reason}`;
  }
  return checks.results
    .map((result) => `- ${result.ok ? "pass" : "fail"}: \`${result.command}\``)
    .join("\n");
}

/**
 * The PR body, section for section, per .github/PULL_REQUEST_TEMPLATE.md:
 * 概要 = summary, 受入条件 = the requirements document's table, 動作確認結果
 * = the last round's checks (or 検査未実施 with its reason), 確認して欲しい点
 * = protected changes + reviewer notes + a Console link to the approved
 * requirements, 関連リンク = `Closes #N` (auto-links the PR work item to the
 * issue — poll_prs.ts's extractLinkedIssueNumbers reads exactly this), 備考
 * = the deploy checklist from classifyDeployNeeds for the factory repo
 * (`deployChecklist`), なし otherwise. No marker and no
 * announcement text (design §7: operational notices go to Discord/Console).
 */
export function buildImplementPrBody(input: ImplementPrBodyInput): string {
  const attention = [
    ...input.protectedChanges.map((line) => `- ${sanitizePrLine(line)}`),
    ...input.notesForReviewer.map((line) => `- ${sanitizePrLine(line)}`),
    `- 要件定義(Console): ${input.requirementsConsoleUrl}`,
  ];
  return [
    "## 概要",
    "",
    sanitizePrProse(input.summary.trim()),
    "",
    "## 受入条件",
    "",
    extractAcceptanceCriteria(input.requirementsMarkdown),
    "",
    "## 動作確認結果",
    "",
    renderChecks(input.checks),
    "",
    "## 確認して欲しい点",
    "",
    ...attention,
    "",
    "## 関連リンク",
    "",
    `Closes #${String(input.issueNumber)}`,
    "",
    "## 備考",
    "",
    ...(input.deployChecklist
      ? renderDeployChecklist(input.changedPaths)
      : ["なし"]),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// decideImplementRoundExit: the verify loop's exit rule (design §2
// implement_verify, §0 "検証が OK になるまで修正を繰り返す")
// ---------------------------------------------------------------------------

export type ImplementRoundExit =
  | "checks_passed"
  | "checks_skipped"
  | "max_rounds"
  | "daily_budget"
  | "stalled"
  | "requirements_gap"
  | "continue";

export type ImplementRoundExitInput = {
  readonly claudeOutcome: ImplementClaudeOutcome;
  /** `skipped` = protected paths changed or no check command configured. */
  readonly checks: "passed" | "failed" | "skipped";
  /** 1-based round number within this verify loop (not the DB's serial). */
  readonly round: number;
  /** factory_config.implement_max_rounds. */
  readonly maxRounds: number;
  readonly dailyBudgetExceeded: boolean;
  /** stallHash of this round's combined check output, `null` when none ran. */
  readonly checkOutputHash: string | null;
  readonly previousCheckOutputHash: string | null;
  /** stallHash of this round's worktree diff. */
  readonly diffHash: string;
  readonly previousDiffHash: string | null;
};

/**
 * Whether implement_verify runs another fix round. Precedence: Claude's
 * own `requirements_gap` always ends the loop; a round that ran no checks
 * exits as `checks_skipped` (design §0b: GitHub CI takes over); passing
 * checks exit; then the guards — round ceiling, daily budget, and stall
 * detection (the diff or the check output is identical to the previous
 * round's, so another fix round would only spend budget). `continue` means
 * the checks failed and none of the guards fired.
 */
export function decideImplementRoundExit(
  state: ImplementRoundExitInput,
): ImplementRoundExit {
  if (state.claudeOutcome === "requirements_gap") return "requirements_gap";
  if (state.checks === "skipped") return "checks_skipped";
  if (state.checks === "passed") return "checks_passed";
  if (state.round >= state.maxRounds) return "max_rounds";
  if (state.dailyBudgetExceeded) return "daily_budget";
  if (
    state.previousDiffHash !== null &&
    state.diffHash === state.previousDiffHash
  ) {
    return "stalled";
  }
  if (
    state.checkOutputHash !== null &&
    state.previousCheckOutputHash !== null &&
    state.checkOutputHash === state.previousCheckOutputHash
  ) {
    return "stalled";
  }
  return "continue";
}

/** sha256 hex of `text` — the stall-detection fingerprint for a round's
 * diff (`git diff` output) and check output. */
export function stallHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
