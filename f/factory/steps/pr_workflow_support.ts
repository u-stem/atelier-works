// Pure decision logic + small additive I/O helpers for the pr_review /
// pr_fix step scripts (spec-cycle2.md §3 M6, §7). Owned by the M6b
// implementer (task boundary: do not edit f/factory/lib/**). Mirrors
// f/factory/lib/poll_support.ts's split:
//   1. Pure functions (decideReviewPrepare, evaluatePrFixSafetyGuards,
//      evaluateFixRoundGuard, decideCollectOutcome, mapFindingsToReviewComments,
//      detectForbiddenChanges, decideFixFinishAction, ...) — no I/O, fully
//      testable with plain fakes (tests/scripts/pr_review_*.test.ts,
//      pr_fix_*.test.ts). Step scripts' main() calls these and only does I/O
//      based on their output.
//   2. Small additive I/O helpers for the operations lib/github.ts /
//      lib/db.ts / lib/workspace.ts still don't expose. getBranchProtected,
//      postIssueComment, setHeadSha, fetchPrHeadRef, and readGitShowFile
//      used to be duplicated here (M6b's own thin copies, written before the
//      lib owners promoted the same functions into github.ts/db.ts/
//      workspace.ts, same signatures) — team-lead fix round 2 item a removed
//      the duplicates once that promotion landed; step scripts now import
//      those five straight from lib. detectEscapingSymlinks/
//      listSymlinkTargets/getDiffNumstat below (team-lead fix round 1b items
//      3/7) remain here since no lib equivalent exists yet.
//
import { mkdtemp, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { ReviewThread } from "../lib/github.ts";
import { maskSecrets } from "../lib/log.ts";
import {
  type ChangedPath,
  type ChangedPathStatus,
  isNewShellScript,
  matchesForbiddenPath,
} from "../lib/protected_paths.ts";
import {
  assertSha,
  type FactoryConfig,
  type FixOutcome,
  type FixReply,
  type FixReplyDecision,
  type IssueProposalStatus,
  isNumber,
  isOneOf,
  isRecord,
  isString,
  type LabelerAssociation,
  type ReviewFinding,
  type ReviewFindingKind,
  type ReviewSeverity,
  type ReviewVerdict,
  type WorkItem,
  type WorkItemKind,
  type WorkItemStatus,
} from "../lib/types.ts";
import type { CommandRunner } from "../lib/workspace.ts";

// Promoted into lib/protected_paths.ts (工程3: implement_support.ts needs
// the same classification without a lib -> steps import); re-exported so
// pr_fix_verify.ts and the existing tests keep importing from here.
export {
  type ChangedPath,
  type ChangedPathStatus,
  FORBIDDEN_BASENAME_PATTERNS,
  FORBIDDEN_PATH_PREFIXES,
  IMPLEMENT_PROTECTED_PATH_PREFIXES,
  isNewShellScript,
  matchesForbiddenPath,
} from "../lib/protected_paths.ts";

// ---------------------------------------------------------------------------
// Role tags (team-lead decision, 2026-09-26): the factory posts to GitHub
// using the operator's own account (not a distinct bot login), so every
// factory-authored post's first line names which job wrote it — a human
// reading the PR timeline otherwise cannot tell a factory post from one the
// operator wrote by hand. Kept here (not factory_config) since the tag text
// is a fixed part of the posting format, not an operator-tunable setting.
// ---------------------------------------------------------------------------

export const ROLE_TAGS = {
  pr_review: "[pr_review 自動レビュー]",
  pr_fix: "[pr_fix 自動返信]",
} as const;

// ---------------------------------------------------------------------------
// Writing-style normalization (team-lead decision, 2026-09-26): this
// project's Japanese language rule (CLAUDE.md §3) forbids mixing ASCII and
// Japanese text with a half-width space between them, but Claude's
// structured-output prose (finding `message`/`suggestion`, review `summary`,
// pr_fix reply `body`) sometimes writes one anyway (e.g. "3 件" instead of
// "3件"). Applied at render time (renderInlineComment/renderReviewSummary/
// renderFixReply below) rather than trusted from the prompt instructions
// alone, since Claude's output is untrusted-influenced free text.
// ---------------------------------------------------------------------------

// Hiragana, katakana, CJK Unified Ideographs (+ Extension A), CJK
// symbols/punctuation (、。「」 etc.), and the halfwidth/fullwidth forms
// block — "a Japanese character" for this rule's purposes.
const JAPANESE_CHAR_CLASS =
  "\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\u3000-\\u303f\\uff00-\\uffef";
// An ASCII alphanumeric, or a `)`/`]`/`` ` `` closing character — the shape
// of character this rule treats as "the end (or start) of an ASCII run".
const ASCII_BOUNDARY_CLASS = "0-9A-Za-z)\\]`";

const JAPANESE_CHAR_RE = new RegExp(`[${JAPANESE_CHAR_CLASS}]`);
const ASCII_BOUNDARY_RE = new RegExp(`[${ASCII_BOUNDARY_CLASS}]`);

// A fenced ``` ... ``` block (across lines) or an inline `...` span (never
// crossing a newline, matching normal Markdown inline-code semantics) —
// content matched here is left untouched by normalizeJapaneseText below.
const CODE_SEGMENT_PATTERN = /```[\s\S]*?```|`[^`\n]*`/g;

/**
 * Removes a single half-width space directly between an ASCII run (ending
 * or starting with an alphanumeric, `)`, `]`, or a closing backtick) and a
 * Japanese character, in either direction (team-lead decision, 2026-09-26:
 * "N 件" -> "N件", "LGTM です" -> "LGTMです", "`code` です" -> "`code`です").
 * Text inside a fenced ``` block or an inline `backtick span` — including a
 * space immediately inside one — is left completely untouched: the closing
 * backtick of a span still counts as an ASCII boundary character for a
 * space just *outside* it, but a space *inside* the span never is. Only a
 * literal " " character is ever removed; a newline is never touched or
 * crossed.
 */
export function normalizeJapaneseText(text: string): string {
  const protectedRanges: Array<readonly [number, number]> = [];
  for (const match of text.matchAll(CODE_SEGMENT_PATTERN)) {
    const start = match.index;
    protectedRanges.push([start, start + match[0].length]);
  }
  const isProtected = (index: number): boolean =>
    protectedRanges.some(([start, end]) => index >= start && index < end);

  let result = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const before = text[i - 1] ?? "";
    const after = text[i + 1] ?? "";
    const removable =
      char === " " &&
      !isProtected(i) &&
      before.length > 0 &&
      after.length > 0 &&
      ((ASCII_BOUNDARY_RE.test(before) && JAPANESE_CHAR_RE.test(after)) ||
        (JAPANESE_CHAR_RE.test(before) && ASCII_BOUNDARY_RE.test(after)));
    if (!removable) {
      result += char;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Review result (2026-09-27 PR label cleanup): PRs no longer carry a state
// label the factory sets/swaps — poll_prs.ts's listTrackedPrs rediscovers a
// PR from work_items instead — so what used to be "which state label to set"
// is now just a plain result value used for the Discord notification and
// nothing else (there is no more GitHub side effect here).
// ---------------------------------------------------------------------------

/** Decides a posted review's result: `"changes_requested"` when at least
 * one finding this round is a `must`, OR when `openMustCount`
 * (pr_workflow_support.ts's `countOpenMustThreads`) is greater than zero —
 * team-lead fix, 2026-09-26: an old `[MUST]` finding left unresolved from a
 * prior round must still flag the PR as needing changes even on a round
 * that itself posts nothing new (`ReviewBodyMode`'s `"rereview_open"`).
 * `"reviewed"` otherwise (including no findings at all and no open `must` —
 * nothing blocking, awaiting human approval). */
export function reviewResultFor(
  findings: readonly ReviewFinding[],
  openMustCount: number,
): "changes_requested" | "reviewed" {
  const hasMustFinding = findings.some((finding) => finding.kind === "must");
  return hasMustFinding || openMustCount > 0 ? "changes_requested" : "reviewed";
}

// ---------------------------------------------------------------------------
// pr_review_prepare: decide whether to proceed (pure)
// ---------------------------------------------------------------------------

export type ReviewPrepareDecision =
  | { readonly skip: true; readonly reason: string }
  | { readonly skip: false };

/** Only proceed when the work item is still a `pr_review` in status
 * `reviewing` — anything else (a race with poll_issues's reconcile
 * cancelling it, or a mis-wired flow_job_id) is skipped, never retried here
 * (spec-cycle2.md §7 item 6). */
export function decideReviewPrepare(
  workItem: Pick<WorkItem, "kind" | "status">,
): ReviewPrepareDecision {
  if (workItem.kind !== "pr_review") {
    return {
      skip: true,
      reason: `work item kind is "${workItem.kind}", not "pr_review"`,
    };
  }
  if (workItem.status !== "reviewing") {
    return {
      skip: true,
      reason: `work item status is "${workItem.status}", not "reviewing"`,
    };
  }
  return { skip: false };
}

// ---------------------------------------------------------------------------
// pr_review_generate: diff truncation note (pure)
// ---------------------------------------------------------------------------

export type PrDiffLike = {
  readonly diff: string;
  readonly truncated: boolean;
  readonly totalLines: number;
};

/** Appends a truncation note to the diff text passed to reviewPrompt when
 * github.ts's getPrDiff cut it short at config.diff_max_lines — the changed
 * files list (passed separately to reviewPrompt) already lets Claude Read
 * the rest; this note just makes the cut explicit in-line. */
export function buildReviewDiffText(prDiff: PrDiffLike): string {
  if (!prDiff.truncated) {
    return prDiff.diff;
  }
  return `${prDiff.diff}\n\n[diff truncated: showing a prefix of ${prDiff.totalLines} total diff lines. See the changed files list below and use Read to inspect the rest.]`;
}

// ---------------------------------------------------------------------------
// pr_review_generate: Claude structured-output type guard (pure)
// ---------------------------------------------------------------------------

const REVIEW_VERDICTS: readonly ReviewVerdict[] = [
  "approve",
  "comment",
  "request_changes",
];
const REVIEW_SEVERITIES: readonly ReviewSeverity[] = [
  "blocker",
  "major",
  "minor",
  "nit",
];
const REVIEW_FINDING_KINDS: readonly ReviewFindingKind[] = [
  "must",
  "imo",
  "nits",
  "q",
];

export type ReviewClaudeOutput = {
  readonly verdict: ReviewVerdict;
  readonly summary: string;
  readonly findings: ReviewFinding[];
};

function isReviewFindingShape(value: unknown): value is ReviewFinding {
  if (!isRecord(value)) return false;
  if (!isString(value.path)) return false;
  if (value.line !== null && !isNumber(value.line)) return false;
  if (value.end_line !== null && !isNumber(value.end_line)) return false;
  if (!isOneOf(value.severity, REVIEW_SEVERITIES)) return false;
  if (!isOneOf(value.kind, REVIEW_FINDING_KINDS)) return false;
  if (!isString(value.message)) return false;
  if (value.suggestion !== null && !isString(value.suggestion)) return false;
  if (value.suggested_code !== null && !isString(value.suggested_code)) {
    return false;
  }
  return true;
}

/** Matches prompts.ts's REVIEW_SCHEMA exactly (the schema actually passed
 * to `claude -p --json-schema`) — not `.claude/skills/factory-review`'s own
 * JSON-schema section, which predates prompts.ts's ReviewFinding shape
 * (severity blocker/major/minor/nit, not high/medium/low) and is out of
 * date; see the implementer's report. */
export function isReviewClaudeOutput(
  value: unknown,
): value is ReviewClaudeOutput {
  if (!isRecord(value)) return false;
  if (!isOneOf(value.verdict, REVIEW_VERDICTS)) return false;
  if (!isString(value.summary)) return false;
  if (!Array.isArray(value.findings)) return false;
  return value.findings.every(isReviewFindingShape);
}

// ---------------------------------------------------------------------------
// pr_review_post: findings -> inline review comments (pure)
// ---------------------------------------------------------------------------

export type ReviewCommentLike = {
  readonly path: string;
  readonly line: number;
  readonly side: "LEFT" | "RIGHT";
  readonly start_line?: number;
  readonly body: string;
};

/** Maps findings to GitHub inline review comments, dropping any finding
 * whose `path` is not among the PR's changed files (GitHub rejects an
 * inline comment on a path outside the diff) or whose `line` can't anchor
 * one (`null` or non-positive) — the dropped findings themselves (not just
 * a count) are returned too, since team-lead's "投稿形式" lists them in the
 * summary comment instead of silently discarding them.
 *
 * A finding with a distinct `end_line` becomes a range-anchored comment
 * (lib/github.ts's `ReviewComment.start_line`): GitHub's Review API takes
 * `start_line` as the first line and `line` as the last, so
 * `start_line = finding.line`, `line = finding.end_line`. An `end_line`
 * before `line` is not a valid range (GitHub rejects the whole review for
 * it), so that case is treated as single-line instead — Claude's own
 * `end_line` is untrusted-influenced output, not a value this function can
 * assume is well-formed. */
export function mapFindingsToReviewComments(
  findings: readonly ReviewFinding[],
  prFiles: readonly string[],
): {
  readonly comments: ReviewCommentLike[];
  readonly droppedFindings: ReviewFinding[];
} {
  const fileSet = new Set(prFiles);
  const comments: ReviewCommentLike[] = [];
  const droppedFindings: ReviewFinding[] = [];
  for (const finding of findings) {
    if (
      finding.line === null ||
      finding.line <= 0 ||
      !fileSet.has(finding.path)
    ) {
      droppedFindings.push(finding);
      continue;
    }
    const endLine = finding.end_line;
    const range =
      endLine !== null && endLine > finding.line
        ? { start_line: finding.line, line: endLine }
        : { line: finding.line };
    comments.push({
      path: finding.path,
      side: "RIGHT",
      ...range,
      body: renderInlineComment(finding),
    });
  }
  return { comments, droppedFindings };
}

const REVIEW_FINDING_KIND_PREFIXES: Record<ReviewFindingKind, string> = {
  must: "[MUST]",
  imo: "[IMO]",
  nits: "[NITS]",
  q: "[Q]",
};

/**
 * The fence to wrap a `suggested_code` block in (team-lead fix, 2026-09-26):
 * three backticks, or one more than the longest run of consecutive
 * backticks `code` itself contains, whichever is longer — a fixed
 * ` ```suggestion ` fence would otherwise be prematurely closed (or its
 * nesting broken) by a suggested code snippet that itself contains a
 * ``` ``` ``` (or longer) run, e.g. a snippet that edits a Markdown fenced
 * block. GitHub renders a suggestion fenced with any length >= 3 the same
 * way, so widening the fence never changes how a plain snippet renders.
 */
export function fenceFor(code: string): string {
  const backtickRuns = code.match(/`+/g);
  const longestRun =
    backtickRuns === null
      ? 0
      : Math.max(...backtickRuns.map((run) => run.length));
  return "`".repeat(Math.max(3, longestRun + 1));
}

/** Renders `code` as a ` ```suggestion ` block, fenced via `fenceFor` above
 * so the fence itself always survives any backtick run `code` contains. */
function renderSuggestionBlock(code: string): string {
  const fence = fenceFor(code);
  return `\n\n${fence}suggestion\n${code}\n${fence}`;
}

/**
 * Renders one finding as an inline review-comment body per the
 * factory-review skill's "投稿形式": a role-tag first line (team-lead
 * decision, 2026-09-26: identifies this as a `pr_review` post), then a
 * second line with the `[MUST]`/`[IMO]`/`[NITS]`/`[Q]` prefix (from `kind`)
 * and `message`, an optional `suggestion` note, and `suggested_code` as a
 * ` ```suggestion ` block (see `renderSuggestionBlock`/`fenceFor` above).
 * `mapFindingsToReviewComments` anchors a multi-line finding's
 * `start_line`/`line` to the finding's own `line`/`end_line`, so the block
 * always applies to exactly the range GitHub shows it against — no separate
 * range note is needed in the body. `message`/`suggestion` are passed
 * through `normalizeJapaneseText` (team-lead decision, 2026-09-26) —
 * `suggested_code` is code, not prose, so it is never touched.
 */
export function renderInlineComment(finding: ReviewFinding): string {
  const prefix = REVIEW_FINDING_KIND_PREFIXES[finding.kind];
  const message = normalizeJapaneseText(finding.message);
  const suggestionText =
    finding.suggestion !== null
      ? `\n\n提案: ${normalizeJapaneseText(finding.suggestion)}`
      : "";
  const codeBlock =
    finding.suggested_code === null
      ? ""
      : renderSuggestionBlock(finding.suggested_code);
  return `${ROLE_TAGS.pr_review}\n${prefix} ${message}${suggestionText}${codeBlock}`;
}

/**
 * Which of the four fixed top-level review-comment bodies
 * `renderReviewSummary` renders (team-lead decision, 2026-09-26: the
 * first-pass review body is no longer Claude's free-form `summary` — it's
 * exactly one of these four forms; `"rereview_open"` added 2026-09-26).
 * `hasPriorReview` (db.ts's `hasPriorReview`) distinguishes a genuine
 * re-review of this PR from the very first one. `"rereview_open"` is the
 * re-review counterpart of `"rereview_clean"` for when this round itself
 * found nothing new, but at least one `[MUST]` finding from a prior round is
 * still open after this round's own thread-resolving pass — a bare LGTM
 * body would otherwise read as "nothing left to do" even though an old
 * required finding remains unaddressed.
 */
export type ReviewBodyMode =
  | "findings"
  | "rereview_clean"
  | "first_clean"
  | "rereview_open";

/** Selects the body mode purely from whether any finding was actually
 * posted inline or dropped this round, whether a factory review of this PR
 * already exists, and (team-lead fix, 2026-09-26) how many of the factory's
 * own `[MUST]` threads remain open after this round's resolving pass
 * (`openMustCount` — see `countOpenMustThreads`, computed by the caller
 * against the pre-resolve thread list minus the ids it is about to resolve).
 * A dropped finding (one that couldn't be posted inline, e.g. its `path`
 * isn't in the diff) still forces mode `"findings"` even when
 * `postedCommentCount` is 0 (team-lead review finding): `renderReviewSummary`
 * always lists dropped findings below the fixed second line, and an LGTM
 * line must never appear directly above that list. Otherwise, when an open
 * `must` finding remains (`openMustCount > 0`), the would-be clean mode
 * (`"rereview_clean"` or, in principle, `"first_clean"` — though a PR's
 * first review can never have a prior open thread to begin with) is
 * upgraded to `"rereview_open"` instead. */
export function decideReviewBodyMode(
  postedCommentCount: number,
  droppedCount: number,
  hasPriorReview: boolean,
  openMustCount: number,
): ReviewBodyMode {
  if (postedCommentCount + droppedCount > 0) return "findings";
  if (openMustCount > 0) return "rereview_open";
  return hasPriorReview ? "rereview_clean" : "first_clean";
}

/**
 * Composes the top-level review comment body per the factory-review
 * skill's "投稿形式": a role-tag + `@author` mention on the first line
 * (team-lead decision, 2026-09-26: identifies this as a `pr_review` post),
 * one of four fixed second lines selected by `mode`, and (when some
 * findings couldn't be posted inline) a bulleted list of them. Claude's own
 * `summary` is never posted here (team-lead decision, 2026-09-26: recorded
 * in factory.reviews / used by Discord only). `verdict` is likewise never
 * included (DB / Discord only, never in the PR body). The caller appends
 * the `<!-- factory:pr_review:<id> -->` marker via github.ts's withMarker.
 *
 * team-lead decision (2026-09-26, wording pass): mode `"findings"` no
 * longer carries the final-Approve-is-human disclaimer line at all — a
 * finding-carrying post already asks the author to look at it ("確認お願い
 * します。"), so the extra disclaimer was redundant there. The `"rereview_clean"`/
 * `"first_clean"` modes (nothing to fix) keep it as their third line, since
 * an LGTM-shaped post is exactly where a human could otherwise read
 * "nothing more to do" into it. `"rereview_open"` (team-lead fix,
 * 2026-09-26 — see `ReviewBodyMode`'s doc comment) uses `openMustCount` to
 * report how many old `[MUST]` findings are still open and carries no
 * disclaimer either, since it explicitly asks for confirmation already.
 * Every literal string here follows this project's Japanese writing-style
 * rule (CLAUDE.md §3 / docs/coding-guidelines.md): no half-width space
 * between an ASCII/digit run and a Japanese character.
 */
export function renderReviewSummary(
  authorLogin: string,
  postedCommentCount: number,
  mode: ReviewBodyMode,
  droppedFindings: readonly ReviewFinding[],
  openMustCount: number,
): string {
  const lines = [`${ROLE_TAGS.pr_review} @${authorLogin}`];
  switch (mode) {
    case "findings":
      lines.push(
        `${String(postedCommentCount)}件コメントしました。確認お願いします。`,
      );
      break;
    case "rereview_clean":
      lines.push("修正を確認しました。LGTMです。");
      lines.push("最終的なApprove判断は人が行ってください。");
      break;
    case "first_clean":
      lines.push("指摘はありません。LGTMです。");
      lines.push("最終的なApprove判断は人が行ってください。");
      break;
    case "rereview_open":
      lines.push(
        `新しい指摘はありません。未対応の指摘が${String(openMustCount)}件残っています。確認お願いします。`,
      );
      break;
  }
  if (droppedFindings.length > 0) {
    lines.push("", "(行に紐づけられなかった指摘)");
    for (const finding of droppedFindings) {
      const prefix = REVIEW_FINDING_KIND_PREFIXES[finding.kind];
      lines.push(
        `- ${prefix} ${finding.path}: ${normalizeJapaneseText(finding.message)}`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * Whether `body` is a `pr_fix` reply (renderFixReply) that closes the loop on
 * its own: the first line is the `pr_fix` role tag and some line is the
 * `対応: \`<sha>\`` form (7-40 hex chars in backticks) it renders for a
 * `"fixed"` reply that actually produced a commit. A reply ending
 * `対応: 見送り` (Claude chose not to act) or `対応: 変更なし` (nothing ended up
 * committed) does NOT count — team-lead decision, 2026-09-26: those two
 * outcomes still need a human's judgment, so the thread stays open for one.
 */
export function isFixedFixReply(body: string): boolean {
  const lines = body.split("\n");
  if (lines[0] !== ROLE_TAGS.pr_fix) return false;
  return lines.some((line) => /^対応: `[0-9a-f]{7,40}`$/.test(line));
}

/**
 * Selects the review threads pr_review_post.ts should resolve on this post
 * (team-lead decision, 2026-09-26, extended 2026-09-26 to every re-review):
 * the factory's own still-unresolved `pr_review` inline-comment threads on
 * this PR — a thread's *first* comment must be authored by `viewer`
 * (case-insensitive, matching isOwnPost's convention) and start with the
 * `pr_review` role tag, mirroring isFactoryPost's login-match-AND-marker rule
 * (the factory runs under the operator's own GitHub account, so login alone
 * can't tell a factory thread from a human one). A thread GitHub already
 * marked resolved is left alone, and a thread a human started (even one the
 * factory later replied in) is never touched, since resolving is scoped to
 * threads the factory itself opened.
 *
 * team-lead review finding: the thread's *last* comment must also be the
 * factory's own (`viewer`-authored) — a human reply left in the thread (even
 * one after the factory's original finding) means the factory did not have
 * the last word, so the thread stays open for a human to actually resolve.
 *
 * `mode` (pr_review_post.ts passes the *pre-`openMustCount`* mode here — see
 * `countOpenMustThreads`'s doc comment below for why — which is always one
 * of `"findings"`/`"rereview_clean"`/`"first_clean"`, never
 * `"rereview_open"` in practice) then decides which viewer-authored last
 * comments count as "addressed" (team-lead decision, 2026-09-26):
 *   - `"rereview_clean"` (re-review, zero findings) — and, defensively,
 *     `"rereview_open"`, which shares its resolving rule: a still-untouched
 *     `pr_review` finding (nothing remained to fix, e.g. a human fixed it by
 *     hand) OR a `pr_fix` reply that names a commit (`isFixedFixReply`).
 *   - `"findings"` (a re-review that still has findings, or a first review):
 *     only a `pr_fix` reply that names a commit — an untouched `pr_review`
 *     finding must stay open here, since this same post may have just left
 *     new findings and only pr_fix's own confirmation closes an old one.
 *   - `"first_clean"` (first review, zero findings): never — there is no
 *     prior factory review for the operator to have addressed anything of,
 *     so nothing is resolved.
 */
export function selectThreadsToResolve(
  threads: readonly ReviewThread[],
  viewer: string,
  mode: ReviewBodyMode,
): string[] {
  if (mode === "first_clean") return [];
  const viewerLower = viewer.toLowerCase();
  return threads
    .filter((thread) => !thread.isResolved)
    .filter(
      (thread) => thread.firstCommentAuthorLogin.toLowerCase() === viewerLower,
    )
    .filter((thread) => thread.firstCommentBody.startsWith(ROLE_TAGS.pr_review))
    .filter(
      (thread) => thread.lastCommentAuthorLogin.toLowerCase() === viewerLower,
    )
    .filter((thread) =>
      mode === "rereview_clean" || mode === "rereview_open"
        ? thread.lastCommentBody.startsWith(ROLE_TAGS.pr_review) ||
          isFixedFixReply(thread.lastCommentBody)
        : isFixedFixReply(thread.lastCommentBody),
    )
    .map((thread) => thread.id);
}

/**
 * Counts the factory's own still-open `[MUST]` `pr_review` findings on this
 * PR (team-lead fix, 2026-09-26) — used by pr_review_post.ts to decide
 * whether a round that itself posts nothing new should still render
 * `"rereview_open"` instead of a bare LGTM (`decideReviewBodyMode`'s
 * `openMustCount` parameter). Mirrors `selectThreadsToResolve`'s own
 * factory-authorship check on the thread's *first* comment (login match
 * case-insensitive, starts with the `pr_review` role tag) — a thread GitHub
 * already marked resolved, or one this same round is about to resolve
 * (`resolvedIds`, `selectThreadsToResolve`'s own return value, computed
 * against the same pre-resolve `threads` snapshot passed here) does not
 * count as open. Additionally requires the finding's own kind prefix — the
 * first comment's *second* line, `renderInlineComment`'s own format — to be
 * `[MUST]` (`REVIEW_FINDING_KIND_PREFIXES.must`); an `[IMO]`/`[NITS]`/`[Q]`
 * finding never blocks a clean re-review body.
 */
export function countOpenMustThreads(
  threads: readonly ReviewThread[],
  viewer: string,
  resolvedIds: readonly string[],
): number {
  const viewerLower = viewer.toLowerCase();
  const resolvedIdSet = new Set(resolvedIds);
  return threads.filter((thread) => {
    if (thread.isResolved) return false;
    if (resolvedIdSet.has(thread.id)) return false;
    if (thread.firstCommentAuthorLogin.toLowerCase() !== viewerLower) {
      return false;
    }
    if (!thread.firstCommentBody.startsWith(ROLE_TAGS.pr_review)) return false;
    const secondLine = thread.firstCommentBody.split("\n")[1] ?? "";
    return secondLine.startsWith(REVIEW_FINDING_KIND_PREFIXES.must);
  }).length;
}

export type OpenFindingForPrompt = {
  readonly path: string;
  readonly line: number | null;
  readonly body: string;
};

/**
 * Maps the factory's own still-open `pr_review` findings on this PR into
 * `reviewPrompt`'s `openFindings` input (team-lead decision, 2026-09-26): a
 * re-review must not re-post a finding substantially the same as one that's
 * already open, so pr_review_generate.ts passes every such finding back to
 * Claude. Selection mirrors `selectThreadsToResolve`'s own factory-authorship
 * check (login match case-insensitive, first comment starts with the
 * `pr_review` role tag) but is independent of `mode`/last-comment state —
 * this only cares whether the finding itself is still unresolved, not who
 * (if anyone) replied to it since. The role-tag line is stripped from
 * `body` (Claude doesn't need to know how the factory tags its own posts).
 * Naturally empty on a PR's first review, since no threads exist yet.
 */
export function openFindingsForPrompt(
  threads: readonly ReviewThread[],
  viewer: string,
): OpenFindingForPrompt[] {
  const viewerLower = viewer.toLowerCase();
  return threads
    .filter((thread) => !thread.isResolved)
    .filter(
      (thread) => thread.firstCommentAuthorLogin.toLowerCase() === viewerLower,
    )
    .filter((thread) => thread.firstCommentBody.startsWith(ROLE_TAGS.pr_review))
    .map((thread) => ({
      path: thread.path,
      line: thread.line,
      body: stripRoleTagLine(thread.firstCommentBody),
    }));
}

/** Strips the `pr_review` role-tag first line from a factory-authored
 * comment body, if present — used by `openFindingsForPrompt` above so
 * Claude sees only the finding's own content. */
function stripRoleTagLine(body: string): string {
  const newlineIndex = body.indexOf("\n");
  if (newlineIndex === -1) return body;
  if (body.slice(0, newlineIndex) !== ROLE_TAGS.pr_review) return body;
  return body.slice(newlineIndex + 1);
}

// ---------------------------------------------------------------------------
// pr_fix_prepare: gate outcome (pure)
// ---------------------------------------------------------------------------

/** pr_fix_prepare.ts's own result discriminator — "proceed" signals
 * downstream steps (collect/apply/verify) to run; the other three are
 * terminal and skip straight to pr_fix_finish.ts (see
 * PrFixFinishOutcome / decideFixFinishAction below, which these three
 * values are also members of). */
export type PrFixGateOutcome =
  | "proceed"
  | "skip"
  | "guard_blocked"
  | "round_exhausted";

// ---------------------------------------------------------------------------
// pr_fix_prepare: safety guards (pure) — spec-cycle2.md §7 item 3,
// docs/security.md "pr_fix の安全策"
// ---------------------------------------------------------------------------

export type PrFixGuardResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export type PrFixSafetyGuardInput = {
  readonly open: boolean;
  readonly headRepoFullName: string | null;
  readonly baseRepoFullName: string;
  readonly draft: boolean;
  readonly baseProtected: boolean;
};

/** The four pre-attempt safety guards (spec-cycle2.md §7 item 3): PR open,
 * head.repo == base.repo (no fork push), not draft, base branch not
 * protected. Checked before creating a worktree or running Claude at all —
 * `commitAndPush` (workspace.ts) separately re-verifies the head sha hasn't
 * moved right before the actual push. */
export function evaluatePrFixSafetyGuards(
  input: PrFixSafetyGuardInput,
): PrFixGuardResult {
  if (!input.open) {
    return { ok: false, reason: "pull request is not open" };
  }
  if (
    input.headRepoFullName === null ||
    input.headRepoFullName !== input.baseRepoFullName
  ) {
    return {
      ok: false,
      reason: "head repository differs from base repository (fork PR)",
    };
  }
  if (input.draft) {
    return { ok: false, reason: "pull request is a draft" };
  }
  if (input.baseProtected) {
    return { ok: false, reason: "base branch is protected" };
  }
  return { ok: true };
}

export function evaluateFixRoundGuard(
  fixRound: number,
  maxFixRounds: number,
): PrFixGuardResult {
  if (fixRound > maxFixRounds) {
    return {
      ok: false,
      reason: `fix_round ${String(fixRound)} exceeds max_fix_rounds ${String(maxFixRounds)}`,
    };
  }
  return { ok: true };
}

/** Defense-in-depth repo allowlist re-check (team-lead fix round 1b item 6):
 * poll_prs.ts already filters candidates through `filterByRepoAllowlist`
 * before a work item is ever created, but a `factory_config` edit after
 * creation (or a manually-inserted row) could leave a stale item pointing
 * at a now-disallowed repo — re-checked here (and in pr_review_prepare.ts)
 * right before any GitHub/workspace I/O against that repo. */
export function evaluateRepoAllowedGuard(allowed: boolean): PrFixGuardResult {
  return allowed
    ? { ok: true }
    : {
        ok: false,
        reason:
          "repository is not allowed by factory_config (owners / repo_allowlist)",
      };
}

// ---------------------------------------------------------------------------
// pr_fix_collect: new review/comment selection + outcome (pure)
// ---------------------------------------------------------------------------

export type RawPrReview = {
  readonly id: number;
  readonly authorLogin: string;
  readonly authorAssociation: LabelerAssociation | string | null;
  readonly body: string;
};

export type RawPrReviewComment = {
  readonly id: number;
  readonly authorLogin: string;
  readonly authorAssociation: LabelerAssociation | string | null;
  readonly path: string;
  readonly line: number | null;
  readonly body: string;
};

export type RawIssueComment = {
  readonly id: number;
  readonly authorLogin: string;
  readonly authorAssociation: LabelerAssociation | string | null;
  readonly body: string;
};

export type CollectedReview = {
  readonly id: number;
  readonly body: string;
  readonly author: string;
};

export type CollectedComment = {
  readonly id: number;
  readonly path: string;
  readonly line: number | null;
  readonly body: string;
  readonly author: string;
};

/** Result of a `selectNew*` pass: the items that passed every filter, plus
 * the login of anyone excluded *solely* because their `author_association`
 * wasn't in `allowed_labeler_associations` (team-lead fix round 1b item 1:
 * the caller uses this to log + record a notice, since a silently-dropped
 * "feedback" post from an untrusted account is otherwise invisible). */
export type SelectResult<T> = {
  readonly items: T[];
  readonly excludedAuthors: string[];
};

/** Reviews with a non-empty body, newer than the `last_review_id`
 * watermark, from an author whose `author_association` is in
 * `allowedAssociations` — an empty-body review (a bare "approve"/"request
 * changes" click) carries no textual feedback for Claude to act on, and an
 * association outside the allowlist means this human feedback is treated
 * the same as an untrusted `factory` label (spec-cycle2.md §7 item 1,
 * extended by fix round 1b item 1). */
export function selectNewReviews(
  reviews: readonly RawPrReview[],
  lastReviewId: number,
  allowedAssociations: readonly LabelerAssociation[],
): SelectResult<CollectedReview> {
  const items: CollectedReview[] = [];
  const excludedAuthors: string[] = [];
  for (const review of reviews) {
    if (review.id <= lastReviewId || review.body.trim().length === 0) {
      continue;
    }
    if (!isOneOf(review.authorAssociation, allowedAssociations)) {
      excludedAuthors.push(review.authorLogin);
      continue;
    }
    items.push({
      id: review.id,
      body: review.body,
      author: review.authorLogin,
    });
  }
  return { items, excludedAuthors };
}

/** Inline review comments newer than the `last_comment_id` watermark, from
 * an allowed author_association. "Unresolved" is approximated by the
 * watermark itself (github.ts has no GraphQL thread-resolution lookup) — a
 * comment id below the watermark was already surfaced to (and replied by) a
 * previous fix round. */
export function selectNewReviewComments(
  comments: readonly RawPrReviewComment[],
  lastCommentId: number,
  allowedAssociations: readonly LabelerAssociation[],
): SelectResult<CollectedComment> {
  const items: CollectedComment[] = [];
  const excludedAuthors: string[] = [];
  for (const comment of comments) {
    if (comment.id <= lastCommentId) continue;
    if (!isOneOf(comment.authorAssociation, allowedAssociations)) {
      excludedAuthors.push(comment.authorLogin);
      continue;
    }
    items.push({
      id: comment.id,
      path: comment.path,
      line: comment.line,
      body: comment.body,
      author: comment.authorLogin,
    });
  }
  return { items, excludedAuthors };
}

/** Plain issue-level comments from an author whose `author_association` is
 * in `allowedAssociations` — github.ts's `listIssueComments` already filters
 * out the factory's own marker-bearing posts and anything older than the
 * `last_comment_id` watermark (`opts.sinceId`). A human writes instructions
 * for a fix as an ordinary comment before adding the `fix_label` (user
 * decision, 2026-09-26: pr_fix has no comment-based trigger of its own, so
 * every comment here is plain feedback for Claude to act on, collected the
 * same way as any other human comment). */
export function selectNewIssueComments(
  comments: readonly RawIssueComment[],
  allowedAssociations: readonly LabelerAssociation[],
): SelectResult<CollectedComment> {
  const items: CollectedComment[] = [];
  const excludedAuthors: string[] = [];
  for (const comment of comments) {
    if (!isOneOf(comment.authorAssociation, allowedAssociations)) {
      excludedAuthors.push(comment.authorLogin);
      continue;
    }
    items.push({
      id: comment.id,
      path: "",
      line: null,
      body: comment.body,
      author: comment.authorLogin,
    });
  }
  return { items, excludedAuthors };
}

export type CollectOutcome = "proceed" | "no_feedback";

/** No new reviews and no new comments since the watermark -> nothing for
 * Claude to address this round (spec-cycle2.md §3 M6: "nothing to address
 * → ... needs_human with notice \"no actionable feedback\""). */
export function decideCollectOutcome(
  reviews: readonly CollectedReview[],
  comments: readonly CollectedComment[],
): CollectOutcome {
  return reviews.length === 0 && comments.length === 0
    ? "no_feedback"
    : "proceed";
}

// ---------------------------------------------------------------------------
// pr_fix_apply / pr_fix_verify: commit message composition (pure)
// ---------------------------------------------------------------------------

/** Joins a fix round's proposed commit subject and (optional) body into the
 * final commit message text `pr_fix_finish.ts` passes to `commitAndPush`
 * (team-lead decision, 2026-09-26 — supersedes the former
 * `buildFixCommitMessage`, which derived a subject from Claude's `summary`
 * field deterministically; Claude now proposes `commit_subject`/
 * `commit_body` directly in its structured output, see `FixClaudeOutput`,
 * so this is a plain join with no truncation logic of its own —
 * `isFixClaudeOutput`'s guard is what enforces the subject's shape).
 * `commitAndPush`'s own `withCommitTrailers` still appends the
 * Co-Authored-By/Generated-By trailers after this. */
export function composeCommitMessage(
  subject: string,
  body: string | null,
): string {
  // The same Japanese spacing rule as posted review text applies to commit
  // messages (user decision, 2026-09-26); inline code spans stay untouched.
  const normalizedSubject = normalizeJapaneseText(subject);
  return body === null
    ? normalizedSubject
    : `${normalizedSubject}\n\n${normalizeJapaneseText(body)}`;
}

// ---------------------------------------------------------------------------
// pr_fix_apply: Claude structured-output type guard (pure)
// ---------------------------------------------------------------------------

const FIX_OUTCOMES: readonly FixOutcome[] = [
  "done",
  "requirements_gap",
  "blocked",
];

const FIX_REPLY_DECISIONS: readonly FixReplyDecision[] = [
  "fixed",
  "skipped",
  "propose_issue",
];

// team-lead fix (2026-09-26): raised from 60 to git's own subject-line
// convention of 72 code points — a small margin over the ~50 characters the
// prompt/skill text asks Claude to aim for, so a subject that runs slightly
// long doesn't throw away a whole Claude run.
const COMMIT_SUBJECT_MAX_CODEPOINTS = 72;

export type FixClaudeOutput = {
  readonly outcome: FixOutcome;
  readonly summary: string;
  readonly replies: FixReply[];
  readonly blocked_reason: string | null;
  readonly commit_subject: string;
  readonly commit_body: string | null;
};

function isIssueProposalDraftShape(
  value: unknown,
): value is { title: string; body: string } {
  return isRecord(value) && isString(value.title) && isString(value.body);
}

/** `decision` is required (team-lead decision, 2026-09-26): a reply without
 * it fails this guard outright rather than being accepted with an implied
 * default, per this codebase's parse-don't-validate convention.
 *
 * `issue_proposal` (user decision, 2026-09-26) must be present (non-null)
 * exactly when `decision` is `"propose_issue"` — `undefined` is treated the
 * same as `null` for every other decision (backward compatibility with a
 * reply recorded before this field existed). */
function isFixReplyShape(value: unknown): value is FixReply {
  if (
    !isRecord(value) ||
    !isNumber(value.review_comment_id) ||
    !isString(value.body) ||
    !isOneOf(value.decision, FIX_REPLY_DECISIONS)
  ) {
    return false;
  }
  if (value.decision === "propose_issue") {
    return isIssueProposalDraftShape(value.issue_proposal);
  }
  return value.issue_proposal === undefined || value.issue_proposal === null;
}

/**
 * Whether `value` is an acceptable `commit_subject` shape (team-lead
 * decision, 2026-09-26, limit revised 2026-09-26): a string of at most
 * `COMMIT_SUBJECT_MAX_CODEPOINTS` Unicode code points — counted via
 * spreading into an array of code points, not `.length`'s UTF-16 code
 * units, since a description could contain astral-plane characters —
 * containing no newline (a commit subject is always one line), and not
 * ending with "…". The ellipsis check exists because this field replaces
 * the former `buildFixCommitMessage`, which silently truncated an
 * overlong subject and appended "…" itself; Claude now writes the whole
 * subject directly, so a trailing "…" means it tried to write something
 * past the limit rather than keeping the subject itself within it. This
 * shape check alone allows an empty string (`""`) — `isFixClaudeOutput`
 * below additionally requires a non-empty, non-whitespace subject when
 * `outcome` is `"done"`.
 */
function isValidCommitSubject(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.includes("\n")) return false;
  if (value.endsWith("…")) return false;
  return [...value].length <= COMMIT_SUBJECT_MAX_CODEPOINTS;
}

/** Matches prompts.ts's FIX_SCHEMA exactly (see isReviewClaudeOutput's note
 * on the same divergence from .claude/skills/factory-fix's own schema
 * section: `blocked_reason` used for both the "blocked" and
 * "requirements_gap" outcomes, and `commit_subject`/`commit_body` — team-lead
 * decision, 2026-09-26 — replacing the former derive-from-`summary`
 * approach).
 *
 * team-lead fix (2026-09-26): when `outcome` is `"done"`, `commit_subject`
 * must additionally be non-empty and not whitespace-only. FIX_SCHEMA's own
 * text asks Claude for `commit_subject: ""` only when there is nothing to
 * commit (any outcome other than "done") — an empty/blank subject on a
 * "done" outcome would otherwise reach pr_fix_finish.ts's
 * `composeCommitMessage` as the commit's subject line, which then promotes
 * the following `Co-Authored-By`/`Generated-By` trailers into the subject
 * (`git commit -m "\n\nCo-Authored-By: ..."`). For every other outcome, `""`
 * is still accepted exactly as before (pr_fix_apply.ts never carries a
 * non-done outcome's `commit_subject` through to an actual commit attempt
 * anyway). */
export function isFixClaudeOutput(value: unknown): value is FixClaudeOutput {
  if (!isRecord(value)) return false;
  if (!isOneOf(value.outcome, FIX_OUTCOMES)) return false;
  if (!isString(value.summary)) return false;
  if (!Array.isArray(value.replies) || !value.replies.every(isFixReplyShape)) {
    return false;
  }
  if (value.blocked_reason !== null && !isString(value.blocked_reason)) {
    return false;
  }
  if (!isValidCommitSubject(value.commit_subject)) return false;
  if (value.outcome === "done" && value.commit_subject.trim().length === 0) {
    return false;
  }
  if (value.commit_body !== null && !isString(value.commit_body)) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// pr_fix_verify: forbidden-change detection (pure) — docs/security.md
// "pr_fix の安全策"
// ---------------------------------------------------------------------------

/** Parses `git status --porcelain` output (XY-prefixed lines; a rename's
 * " -> " arrow is resolved to the new path). Untracked ("??") and staged-add
 * ("A ") both count as "added" — the "new *.sh file" forbidden check only
 * fires for these, never for an existing tracked file being edited. `T`
 * (typechange, either side — team-lead security re-gate N1/N6) is its own
 * status: a tracked path whose git object type itself changed (most
 * relevantly regular file <-> symlink) — checked out and given priority
 * over the plain "modified" bucket since a converted-away-from symlink may
 * no longer show mode 120000 in `git ls-files -s` at all, making this the
 * only signal left that a symlink was involved. */
export function parseGitStatusPorcelain(output: string): ChangedPath[] {
  const entries: ChangedPath[] = [];
  for (const rawLine of output.split("\n")) {
    if (rawLine.trim().length === 0) continue;
    const xy = rawLine.slice(0, 2);
    let rest = rawLine.slice(3);
    const arrowIndex = rest.indexOf(" -> ");
    if (arrowIndex !== -1) {
      rest = rest.slice(arrowIndex + 4);
    }
    const path = rest.trim();
    if (path.length === 0) continue;

    let status: ChangedPathStatus = "unknown";
    if (xy === "??" || xy.includes("A")) {
      status = "added";
    } else if (xy.includes("T")) {
      status = "typechange";
    } else if (xy.includes("D")) {
      status = "deleted";
    } else if (xy.includes("M") || xy.includes("R") || xy.includes("C")) {
      status = "modified";
    }
    entries.push({ path, status });
  }
  return entries;
}

export function parseGitDiffNameOnly(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function statusFromNameStatus(code: string): ChangedPathStatus {
  switch (code.charAt(0)) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "T":
      return "typechange";
    default:
      return "unknown";
  }
}

/** `git diff -z --name-status` (工程3 design §14): NUL-separated and never
 * C-quoted, unlike the newline forms whose quoting of non-ASCII / control
 * characters let such paths slip past matchesForbiddenPath. A rename
 * (`R<score>\0old\0new`) becomes a deletion of the old path plus an
 * addition of the new one, so moving a protected file out of its protected
 * location is still classified; a copy (`C<score>\0src\0dst`) becomes an
 * addition of `dst`. */
export function parseGitDiffNameStatusZ(output: string): ChangedPath[] {
  const fields = output.split("\u0000");
  const entries: ChangedPath[] = [];
  let index = 0;
  while (index < fields.length) {
    const code = fields[index] ?? "";
    index += 1;
    if (code.length === 0) continue;
    const kind = code.charAt(0);
    if (kind === "R" || kind === "C") {
      const source = fields[index] ?? "";
      const destination = fields[index + 1] ?? "";
      index += 2;
      if (kind === "R" && source.length > 0) {
        entries.push({ path: source, status: "deleted" });
      }
      if (destination.length > 0) {
        entries.push({ path: destination, status: "added" });
      }
      continue;
    }
    const path = fields[index] ?? "";
    index += 1;
    if (path.length > 0) {
      entries.push({ path, status: statusFromNameStatus(code) });
    }
  }
  return entries;
}

/** Every path that differs between `baseSha` (the branch's merge-base with
 * the default branch) and the staged worktree, from `git diff --cached -z
 * --name-status`. The implement flow calls this after worktreeFingerprint
 * staged everything, so commits made earlier on the branch are included. */
export async function listChangedPaths(
  run: CommandRunner,
  worktreeDir: string,
  baseSha: string,
): Promise<ChangedPath[]> {
  assertSha(baseSha);
  const result = await run(
    gitHardeningArgv([
      "diff",
      "--cached",
      "-z",
      "--name-status",
      "--no-ext-diff",
      baseSha,
      "--",
    ]),
    {
      cwd: worktreeDir,
      env: resolvedEnv({ GIT_TERMINAL_PROMPT: "0" }, undefined, undefined),
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      maskSecrets(
        `git diff --cached -z --name-status failed in ${worktreeDir}: ${result.stderr.trim()}`,
      ),
    );
  }
  return parseGitDiffNameStatusZ(result.stdout);
}

/** Union of `git status --porcelain` (which alone already covers both
 * staged and unstaged changes, tracked and untracked) and
 * `git diff --name-only` (belt-and-suspenders per this task's instructions)
 * — a path present in only the latter is classified "modified" since it is
 * by definition a tracked file already known to git. */
export function mergeChangedPaths(
  statusPaths: readonly ChangedPath[],
  diffPaths: readonly string[],
): ChangedPath[] {
  const byPath = new Map<string, ChangedPath>();
  for (const entry of statusPaths) {
    byPath.set(entry.path, entry);
  }
  for (const path of diffPaths) {
    if (!byPath.has(path)) {
      byPath.set(path, { path, status: "modified" });
    }
  }
  return [...byPath.values()];
}

export type ForbiddenChangeResult = {
  readonly blocked: boolean;
  readonly reasons: string[];
};

/** The full forbidden-change check: path-pattern violations, a newly added
 * `*.sh` file, a changed package.json `scripts` field (via the caller-
 * computed flag), and any caller-supplied `extraReasons` (team-lead fix
 * round 1b item 3: escaping-symlink reasons from detectEscapingSymlinks). */
export function detectForbiddenChanges(
  paths: readonly ChangedPath[],
  packageJsonScriptsChangedFlag: boolean,
  extraReasons: readonly string[] = [],
): ForbiddenChangeResult {
  const reasons: string[] = [];
  for (const entry of paths) {
    if (matchesForbiddenPath(entry.path)) {
      reasons.push(`forbidden path changed: ${entry.path}`);
    } else if (isNewShellScript(entry)) {
      reasons.push(`new shell script added: ${entry.path}`);
    }
  }
  if (packageJsonScriptsChangedFlag) {
    reasons.push('package.json "scripts" field changed');
  }
  reasons.push(...extraReasons);
  return { blocked: reasons.length > 0, reasons };
}

// ---------------------------------------------------------------------------
// pr_fix_verify: escaping-symlink detection (pure + I/O) — team-lead fix
// round 1b item 3. impl-lib-exec is separately adding `core.symlinks=false`
// to worktree creation (workspace.ts), which stops git itself from
// materializing a *tracked* symlink as a real OS symlink on checkout; this
// check is an independent, complementary defense at verify time against any
// symlink that ends up in the diff regardless of how it got there, since
// Claude's Write tool follows an existing symlink at its target path rather
// than replacing it (a plain `fs.writeFile`-style open does not use
// O_NOFOLLOW), which would otherwise let a write silently land outside the
// worktree.
// ---------------------------------------------------------------------------

export type SymlinkTarget = {
  readonly path: string;
  readonly target: string;
};

/** Parses `git ls-files -s` output (`<mode> <sha> <stage>\t<path>` per
 * line), returning only the entries whose mode is `120000` (a symlink). */
export function parseSymlinkModePaths(output: string): string[] {
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    if (line.trim().length === 0) continue;
    const tabIndex = line.indexOf("\t");
    if (tabIndex === -1) continue;
    const mode = line.slice(0, tabIndex).trim().split(/\s+/)[0];
    const path = line.slice(tabIndex + 1).trim();
    if (mode === "120000" && path.length > 0) {
      paths.push(path);
    }
  }
  return paths;
}

/** Resolves a symlink's target (as git/the OS would) relative to its own
 * directory inside the worktree, to an absolute path. */
export function resolveSymlinkTarget(
  worktreeDir: string,
  symlinkRelPath: string,
  targetText: string,
): string {
  return resolve(dirname(join(worktreeDir, symlinkRelPath)), targetText);
}

/** Whether a symlink's resolved target falls outside `worktreeDir` —
 * covers both a `..`-relative escape and an absolute-path target. */
export function isEscapingSymlink(
  worktreeDir: string,
  symlinkRelPath: string,
  targetText: string,
): boolean {
  const resolved = resolveSymlinkTarget(
    worktreeDir,
    symlinkRelPath,
    targetText,
  );
  const root = resolve(worktreeDir);
  return resolved !== root && !resolved.startsWith(`${root}${sep}`);
}

/** Formats one `detectForbiddenChanges`-style reason string per escaping
 * symlink. */
export function detectEscapingSymlinks(
  worktreeDir: string,
  symlinkTargets: readonly SymlinkTarget[],
): string[] {
  const reasons: string[] = [];
  for (const entry of symlinkTargets) {
    if (isEscapingSymlink(worktreeDir, entry.path, entry.target)) {
      reasons.push(
        `symlink escapes the worktree: ${entry.path} -> ${entry.target}`,
      );
    }
  }
  return reasons;
}

/**
 * Blocks every symlink creation/modification/typechange unconditionally —
 * team-lead security re-gate N1/N6, a superset of (kept alongside, not
 * replacing) detectEscapingSymlinks's more specific "resolves outside the
 * worktree" reason above. Two independent signals, since a symlink
 * converted *away from* (e.g. replaced by a regular file) may no longer
 * show mode 120000 in `git ls-files -s` at all:
 *   - any changed path that's currently a symlink (present in
 *     `symlinkTargets`, i.e. mode 120000 right now) — covers a new symlink
 *     and an existing symlink whose target changed.
 *   - any changed path `parseGitStatusPorcelain` classified `typechange` —
 *     covers a symlink <-> regular-file conversion either direction, which
 *     `git ls-files -s`'s current-state snapshot alone would miss once the
 *     symlink is gone.
 */
export function detectSymlinkChanges(
  paths: readonly ChangedPath[],
  symlinkTargets: readonly SymlinkTarget[],
): string[] {
  const symlinkPaths = new Set(symlinkTargets.map((entry) => entry.path));
  const reasons: string[] = [];
  for (const entry of paths) {
    if (symlinkPaths.has(entry.path)) {
      reasons.push(`symlink_change: symlink changed: ${entry.path}`);
    } else if (entry.status === "typechange") {
      reasons.push(
        `symlink_change: file type changed (possible symlink conversion): ${entry.path}`,
      );
    }
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// pr_fix_verify: diff size limits (pure + I/O) — team-lead fix round 1b
// item 7. A fix pass touching an unbounded number of files/lines is both a
// review burden and a bigger blast radius for an automated push; blocking
// past factory_config.max_fix_changed_files / max_fix_diff_lines gives an
// explicit, operator-tunable ceiling (defaults 30 files / 1500 total
// added+deleted lines) alongside the unconditional forbidden-path checks.
// ---------------------------------------------------------------------------

export type DiffNumstatEntry = {
  readonly path: string;
  // `git diff --numstat` reports "-" (not a number) for a binary file's
  // added/deleted counts — kept as `null` rather than coerced to 0 so
  // sumDiffNumstatLines's caller can tell "no line-level diff available"
  // apart from "a real 0-line change" if it ever needs to.
  readonly additions: number | null;
  readonly deletions: number | null;
};

/** Parses `git diff --numstat` output (`<added>\t<deleted>\t<path>` per
 * line, tab-separated; a rename is reported as a single `path` field
 * containing " => " rather than the porcelain-status arrow, which this
 * parser passes through as-is since only the line counts are used here). */
export function parseGitDiffNumstat(output: string): DiffNumstatEntry[] {
  const entries: DiffNumstatEntry[] = [];
  for (const line of output.split("\n")) {
    if (line.trim().length === 0) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [addRaw, delRaw, ...pathParts] = parts;
    const path = pathParts.join("\t").trim();
    if (path.length === 0) continue;
    entries.push({
      path,
      additions: addRaw === "-" ? null : safeInt(addRaw),
      deletions: delRaw === "-" ? null : safeInt(delRaw),
    });
  }
  return entries;
}

function safeInt(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : null;
}

/** Sums additions+deletions across every entry (a binary file's `null`
 * counts contribute 0, since `git diff --numstat` gives no line count for
 * one — it's still caught by the changed-file-count half of the guard). */
export function sumDiffNumstatLines(
  entries: readonly DiffNumstatEntry[],
): number {
  let total = 0;
  for (const entry of entries) {
    total += entry.additions ?? 0;
    total += entry.deletions ?? 0;
  }
  return total;
}

/** Reads `git diff --numstat` in `worktreeDir` (unstaged changes against
 * the index, matching the same working-tree state pr_fix_verify's other
 * checks look at). */
export async function getDiffNumstat(
  run: CommandRunner,
  worktreeDir: string,
): Promise<DiffNumstatEntry[]> {
  const result = await run(gitHardeningArgv(["diff", "--numstat"]), {
    cwd: worktreeDir,
    env: resolvedEnv({ GIT_TERMINAL_PROMPT: "0" }, undefined, undefined),
  });
  if (result.exitCode !== 0) {
    throw new Error(
      maskSecrets(
        `git diff --numstat failed in ${worktreeDir}: ${result.stderr.trim()}`,
      ),
    );
  }
  return parseGitDiffNumstat(result.stdout);
}

/** Parses `wc -l`'s single-line stdout (`<count> <path>`, count
 * right-padded with spaces by `wc` itself) down to the leading integer. */
export function parseWcLineCount(output: string): number {
  const match = output.trim().match(/^(\d+)/);
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

/**
 * Counts an untracked (newly added) file's lines via `wc -l` — team-lead
 * fix round 2 item 7 addendum: `git diff --numstat` never lists an
 * untracked file at all (it diffs the working tree against the index, and
 * an untracked file isn't in the index), so its lines would otherwise be
 * invisible to the diff-size guard entirely. `git add -N` (intent-to-add)
 * would make it show up in numstat too, but mutates the worktree's git
 * index as a side effect — `wc -l` has none. A file `wc` can't read (raced/
 * deleted after `git status` reported it, or genuinely binary in some
 * environments) counts as 0 rather than throwing, matching
 * `listSymlinkTargets`'s "the rest of the safety net covers it" stance.
 */
export async function countUntrackedFileLines(
  run: CommandRunner,
  worktreeDir: string,
  path: string,
): Promise<number> {
  const result = await run(["wc", "-l", "--", path], { cwd: worktreeDir });
  if (result.exitCode !== 0) return 0;
  return parseWcLineCount(result.stdout);
}

/** Which factory_config keys a diff-size reason names — pr_fix and the
 * implement flow have separate ceilings (工程3 design §3), and the reason
 * text must cite the key the operator would actually tune. */
export type DiffSizeLimitNames = {
  readonly changedFiles: keyof FactoryConfig;
  readonly diffLines: keyof FactoryConfig;
};

export const PR_FIX_DIFF_SIZE_LIMIT_NAMES: DiffSizeLimitNames = {
  changedFiles: "max_fix_changed_files",
  diffLines: "max_fix_diff_lines",
};

export const IMPLEMENT_DIFF_SIZE_LIMIT_NAMES: DiffSizeLimitNames = {
  changedFiles: "implement_max_changed_files",
  diffLines: "implement_max_diff_lines",
};

/** Blocks when the changed-file count or the total added+deleted line count
 * exceeds factory_config's configured ceiling. `changedFileCount` is the
 * caller's already-computed status+diff-name-only union (the same set the
 * forbidden-path check uses) rather than a second file count derived from
 * numstat alone, since numstat doesn't list untracked (newly added) files
 * that `git status --porcelain` does. `names` selects which config keys the
 * reason text cites (default: pr_fix's). */
export function evaluateDiffSizeGuard(
  changedFileCount: number,
  diffLineTotal: number,
  maxChangedFiles: number,
  maxDiffLines: number,
  names: DiffSizeLimitNames = PR_FIX_DIFF_SIZE_LIMIT_NAMES,
): string[] {
  const reasons: string[] = [];
  if (changedFileCount > maxChangedFiles) {
    reasons.push(
      `changed file count ${String(changedFileCount)} exceeds ${names.changedFiles} ${String(maxChangedFiles)}`,
    );
  }
  if (diffLineTotal > maxDiffLines) {
    reasons.push(
      `diff line total ${String(diffLineTotal)} exceeds ${names.diffLines} ${String(maxDiffLines)}`,
    );
  }
  return reasons;
}

/**
 * For each of `paths` that `git ls-files -s` reports as a symlink (mode
 * `120000`), reads its on-disk target (the actual current worktree state,
 * not the git blob, since a stale git blob wouldn't reflect a symlink
 * Claude's tools wrote through — though as the module note above explains,
 * Write/Edit alone cannot originate a *new* OS-level symlink; this also
 * catches a pre-existing tracked symlink the diff merely touched). A
 * symlink git reports but that's unreadable on disk (raced/deleted) is
 * skipped rather than thrown — the forbidden-path and
 * `allowed_check_commands` checks are the rest of the safety net.
 */
export async function listSymlinkTargets(
  run: CommandRunner,
  worktreeDir: string,
  paths: readonly string[],
  readLink: (path: string) => Promise<string> = (path) => readlink(path),
): Promise<SymlinkTarget[]> {
  if (paths.length === 0) return [];
  const result = await run(
    gitHardeningArgv(["ls-files", "-s", "--", ...paths]),
    {
      cwd: worktreeDir,
      env: resolvedEnv({ GIT_TERMINAL_PROMPT: "0" }, undefined, undefined),
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      maskSecrets(
        `git ls-files -s failed in ${worktreeDir}: ${result.stderr.trim()}`,
      ),
    );
  }
  const symlinkPaths = parseSymlinkModePaths(result.stdout);
  const targets: SymlinkTarget[] = [];
  for (const path of symlinkPaths) {
    try {
      const target = await readLink(join(worktreeDir, path));
      targets.push({ path, target });
    } catch {}
  }
  return targets;
}

/** Whether package.json's `scripts` object differs between two file
 * contents (either may be `null`, meaning the file didn't exist at that
 * point). Invalid JSON is treated as "no scripts" rather than thrown —
 * package.json content is untrusted target-repo data, never parsed with
 * anything beyond JSON.parse, and a parse failure alone isn't a forbidden
 * change (the check commands will surface a broken package.json on their
 * own). */
export function packageJsonScriptsChanged(
  beforeText: string | null,
  afterText: string | null,
): boolean {
  return (
    JSON.stringify(extractScripts(beforeText)) !==
    JSON.stringify(extractScripts(afterText))
  );
}

function extractScripts(text: string | null): Record<string, string> {
  if (text === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!isRecord(parsed) || !isRecord(parsed.scripts)) return {};
  const scripts: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.scripts)) {
    if (typeof value === "string") scripts[key] = value;
  }
  return scripts;
}

// ---------------------------------------------------------------------------
// pr_fix_verify: run factory_config.allowed_check_commands (I/O)
// ---------------------------------------------------------------------------

export type CheckCommandResult = {
  readonly command: string;
  readonly ok: boolean;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly outputTail: string;
  /** The whole combined stdout+stderr as far as
   * CHECK_COMMAND_MAX_OUTPUT_BYTES kept it, masked — the implement flow
   * stores its first 16KB on implement_rounds.check_output
   * (truncateCheckOutput). `outputTail` stays the prompt-side excerpt. */
  readonly output: string;
};

const CHECK_OUTPUT_TAIL_CHARS = 2000;

export const CHECK_COMMAND_MAX_OUTPUT_BYTES = 1024 * 1024;

export type CheckHomeDir = {
  readonly path: string;
  readonly cleanup: () => Promise<void>;
};

export type CreateCheckHomeDir = () => Promise<CheckHomeDir>;

/** Creates a fresh, private temp dir for one `runAllowedCheckCommands` call
 * (team-lead fix round 1b item 8: a fixed `/tmp/factory-home` shared across
 * every run would let one run's check tooling — cache files, a planted
 * config — persist for a later run against a different PR/repo to read,
 * since these commands execute untrusted target-repo code as root with no
 * other isolation). Mirrors claude.ts's buildSystemPrompt/WriteTempFile
 * mkdtemp+cleanup pattern. */
const defaultCreateCheckHomeDir: CreateCheckHomeDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "factory-check-home-"));
  return {
    path: dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
};

/**
 * Runs each `allowed_check_commands` entry in `cwd` sequentially, with a
 * minimal explicit env (PATH + a fresh private HOME, no inherited secrets —
 * docs/security.md "env -i PATH=... HOME=..."), removing the HOME dir when
 * done. Never grants mise config trust (no MISE_TRUSTED_CONFIG_PATHS, no
 * `mise --yes trust`); a check command that can't run without it (e.g.
 * `mise run check` against an untrusted target-repo mise.toml) simply fails
 * like any other non-zero exit, which the caller treats as a normal check
 * failure (one Claude retry pass, then `blocked`) — this achieves the same
 * "never execute what needs trust" end state as an explicit pre-check
 * without needing to parse the command for a "depends on mise.toml"
 * heuristic. Commands are split on whitespace into argv (no shell), since
 * `allowed_check_commands` is operator-authored (factory_config), not
 * target-repo content.
 */
export async function runAllowedCheckCommands(
  run: CommandRunner,
  cwd: string,
  commands: readonly string[],
  timeoutMs: number,
  createHomeDir: CreateCheckHomeDir = defaultCreateCheckHomeDir,
  path: string | undefined = process.env.PATH,
): Promise<CheckCommandResult[]> {
  const homeDir = await createHomeDir();
  try {
    const env: Record<string, string> = { HOME: homeDir.path };
    if (path !== undefined) env.PATH = path;

    const results: CheckCommandResult[] = [];
    for (const command of commands) {
      const argv = command
        .trim()
        .split(/\s+/)
        .filter((token) => token.length > 0);
      if (argv.length === 0) continue;
      const result = await run(argv, {
        cwd,
        env,
        timeoutMs,
        maxOutputBytes: CHECK_COMMAND_MAX_OUTPUT_BYTES,
      });
      const masked = maskSecrets(`${result.stdout}\n${result.stderr}`.trim());
      results.push({
        command,
        ok: !result.timedOut && result.exitCode === 0,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        outputTail: masked.slice(-CHECK_OUTPUT_TAIL_CHARS),
        output: masked,
      });
    }
    return results;
  } finally {
    await homeDir.cleanup();
  }
}

// team-lead fix round 1b item 9: buildCheckFailureSection used to be
// appended to the retry prompt as unfenced plain text; prompts.ts's
// fixPrompt now takes a `checkFailures` input and fences the output itself
// (pr_fix_verify.ts maps CheckCommandResult -> prompts.ts's CheckFailure
// directly), so this helper is removed rather than left as dead code.

// ---------------------------------------------------------------------------
// pr_fix_finish: outcome routing (pure)
// ---------------------------------------------------------------------------

export type PrFixFinishOutcome =
  | "skip"
  | "guard_blocked"
  | "round_exhausted"
  | "no_feedback"
  | "done"
  | "requirements_gap"
  | "blocked";

export type PrFixFinalAction =
  | { readonly kind: "noop" }
  | { readonly kind: "push" }
  | { readonly kind: "requirements_gap_reroute" }
  | { readonly kind: "requirements_gap_needs_human" }
  | { readonly kind: "guard_blocked" }
  | { readonly kind: "needs_human" };

/**
 * Routes the merged outcome (from whichever of prepare/collect/apply/verify
 * last ran) to the terminal action pr_fix_finish.ts should take.
 *
 * `guard_blocked` (prepare's PR-open/fork/draft/protected-branch guards)
 * maps to the work_items "blocked" status per docs/security.md ("違反は
 * blocked として中断する"). `blocked` (Claude's own decision, or a
 * forbidden-file/check-command failure surfaced by pr_fix_verify) maps to
 * "needs_human" per this task's explicit instructions ("blocked → needs_human").
 * These are deliberately different terminal statuses for two different
 * failure classes, even though both originate from a "blocked"-shaped
 * upstream result.
 */
export function decideFixFinishAction(
  outcome: PrFixFinishOutcome,
  hasParent: boolean,
): PrFixFinalAction {
  switch (outcome) {
    case "skip":
      return { kind: "noop" };
    case "done":
      return { kind: "push" };
    case "requirements_gap":
      return hasParent
        ? { kind: "requirements_gap_reroute" }
        : { kind: "requirements_gap_needs_human" };
    case "guard_blocked":
      return { kind: "guard_blocked" };
    case "round_exhausted":
    case "no_feedback":
    case "blocked":
      return { kind: "needs_human" };
  }
}

/**
 * Whether pr_fix_finish.ts should advance the processed watermarks
 * (`last_review_id` / `last_comment_id` / `last_review_comment_id`) for a
 * given terminal outcome of `main()`. team-lead fix (2026-09-26): the
 * watermarks used to be bumped unconditionally at the top of `main()`,
 * before the outcome was known — when a later step then threw (observed:
 * `git commit` failing), the work item became `failed` with its watermarks
 * already past the feedback that triggered this round, so
 * `retry_work_item` re-ran `pr_fix_collect` with nothing left to collect and
 * landed in `needs_human` ("no actionable feedback") instead of actually
 * retrying (docs/operations.md's former "pr_fix の再実行" note documented
 * this as a known limitation; it is a bug, fixed here).
 *
 * The watermarks must only advance once this round's feedback was actually
 * consumed:
 *   - `push_success`: the fix was committed and pushed, and replies were
 *     posted to the comments that triggered it. Still counts as
 *     `push_success` (user decision, 2026-09-26) even when the round also
 *     recorded one or more `propose_issue` proposals and therefore ends
 *     `needs_human` rather than `rereview_requested` — the underlying
 *     comments were replied to (with a proposal, not a fix) either way, so
 *     this round's feedback is consumed the same as any other successful
 *     push.
 *   - `requirements_gap_reroute_success`: the feedback was consumed by
 *     rerouting the parent issue back to `requirements_generating`.
 * Every other terminal kind here — a guard blocking the attempt before it
 * started, `needs_human` from any cause, a failed reroute (no parent /
 * relabel failure), or a push that didn't actually land (missing commit
 * message, moved head, nothing to commit) — must leave the watermarks
 * untouched, so a subsequent `retry_work_item` re-collects the same
 * feedback. An exception anywhere in `main()` (→ `failed`, handled by
 * on_error_flow.ts, not this function) never reaches a bump call either.
 */
export type PrFixFinishBumpKind =
  | "guard_blocked"
  | "needs_human"
  | "requirements_gap_needs_human"
  | "requirements_gap_reroute_failed"
  | "requirements_gap_reroute_success"
  | "push_missing_commit_message"
  | "push_head_changed"
  | "push_nothing_to_commit"
  | "push_success";

export function shouldAdvanceWatermarks(kind: PrFixFinishBumpKind): boolean {
  return kind === "requirements_gap_reroute_success" || kind === "push_success";
}

/**
 * Guard for pr_fix_finish.ts's requirements_gap reroute (pure, for
 * testing): `null` means the reroute may proceed, otherwise the reason it
 * must fall back to needs_human. The 2026-09-27 label cleanup (both Issue
 * and PR sides) means no label is ever re-applied to the parent issue any
 * more, so the only remaining precondition is that the parent work item
 * actually is an issue.
 */
export function evaluateRerouteGuard(
  issueNumber: number | null,
): string | null {
  return issueNumber === null ? "parent work item has no issue_number" : null;
}

/** Fallback reviewer set when `factory_config.default_reviewers` is empty:
 * the humans whose reviews/comments triggered this fix round (github.ts's
 * PullRequest has no "existing requested reviewers" field to read instead —
 * see the implementer's report). Deduplicated, empty logins dropped. */
export function deriveFallbackReviewers(
  reviewAuthors: readonly string[],
  commentAuthors: readonly string[],
): string[] {
  const set = new Set(
    [...reviewAuthors, ...commentAuthors].filter((login) => login.length > 0),
  );
  return [...set];
}

// GitHub's own closing-keyword syntax: close/closes/closed, fix/fixes/fixed,
// resolve/resolves/resolved (case-insensitive), each optionally followed by
// a colon, then either a bare `#N` (always same-repo, GitHub's own
// shorthand meaning) or an explicit `owner/repo#N`. Captures ($1,$2) the
// owner/repo when present so the caller can filter a cross-repo reference
// out; a fresh RegExp instance is built per call (see below) since a
// module-level `g`-flag pattern would carry `lastIndex` state across calls.
const LINKED_ISSUE_PATTERN =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s*(?:([\w.-]+)\/([\w.-]+))?#(\d+)/gi;

/**
 * Extracts the issue numbers a PR body closes via GitHub's own
 * closing-keyword syntax — team-lead's "link a human-authored PR to its
 * approved requirements" feature (poll_prs.ts uses the first result to look
 * up an approved pipeline work item for that issue and set the new
 * pr_review/pr_fix row's `parent_work_item_id`). An explicit `owner/repo#N`
 * reference is only kept when `owner`/`repo` match this PR's own repo
 * (case-insensitive) — a cross-repo reference doesn't link to anything this
 * factory instance can look up. Deduplicated, first-occurrence order
 * preserved.
 */
export function extractLinkedIssueNumbers(
  body: string,
  owner: string,
  repo: string,
): number[] {
  const pattern = new RegExp(
    LINKED_ISSUE_PATTERN.source,
    LINKED_ISSUE_PATTERN.flags,
  );
  const seen = new Set<number>();
  const result: number[] = [];
  let match: RegExpExecArray | null = pattern.exec(body);
  while (match !== null) {
    const [, matchedOwner, matchedRepo, numberText] = match;
    if (matchedOwner !== undefined && matchedRepo !== undefined) {
      const sameRepo =
        matchedOwner.toLowerCase() === owner.toLowerCase() &&
        matchedRepo.toLowerCase() === repo.toLowerCase();
      if (!sameRepo) {
        match = pattern.exec(body);
        continue;
      }
    }
    const issueNumber = Number(numberText);
    if (Number.isFinite(issueNumber) && !seen.has(issueNumber)) {
      seen.add(issueNumber);
      result.push(issueNumber);
    }
    match = pattern.exec(body);
  }
  return result;
}

/** Drops any reply whose `review_comment_id` isn't one of the comment ids
 * pr_fix_collect.ts actually gathered (team-lead fix round 1b item 10):
 * Claude's structured output is untrusted-influenced (it was asked to
 * address specific comments, but nothing stops it echoing back a
 * hallucinated or attacker-suggested id), and both GitHub reply paths
 * (`replyReviewComment` / `postIssueComment`) would otherwise still act on
 * an id we never actually collected. */
export function filterKnownReplies(
  replies: readonly FixReply[],
  knownCommentIds: ReadonlySet<number>,
): FixReply[] {
  return replies.filter((reply) =>
    knownCommentIds.has(reply.review_comment_id),
  );
}

/**
 * Renders a pr_fix reply body per the factory-fix skill's "返信形式"
 * (team-lead decision, 2026-09-26, superseding the earlier
 * `appendCommitShaNote`): a role-tag first line, then Claude's own `body`
 * (an explanation only — the "対応しました:"/"対応しません:" prefix this
 * used to require from Claude is now rendered here instead), a blank line,
 * and a final `対応: <sha7>` line — or `対応: 見送り` when `reply.decision`
 * is `"skipped"`, since there is no commit to point to for a reply Claude
 * chose not to act on. `newSha` is `null` on the `nothing_to_commit` path
 * (team-lead fix: pr_fix_finish.ts still posts queued replies even when
 * there was nothing to commit) — a `"fixed"` reply then renders `対応: 変更
 * なし` instead of a sha, since none exists. The caller appends the
 * `<!-- factory:pr_fix:<id> -->` marker via github.ts's withMarker after
 * this, same as before. `reply.body` is passed through
 * `normalizeJapaneseText` (team-lead decision, 2026-09-26).
 *
 * When `reply.decision` is `"propose_issue"` (user decision, 2026-09-26),
 * the body instead carries the proposed Issue's title (`提案するIssue:
 * <title>`) and a blockquote of the first 3 lines of its body, ending
 * `対応: Issue化を提案(承認待ち)` — a human approves or rejects the actual
 * Issue creation from the Console Inbox (issue_proposal_apply.ts), which
 * posts its own follow-up reply once decided. A `"propose_issue"` reply
 * with no `issue_proposal` (should not happen once `isFixReplyShape` has
 * validated it, but this function accepts any `FixReply`) falls back to an
 * empty title/body rather than throwing.
 */
export function renderFixReply(reply: FixReply, newSha: string | null): string {
  if (reply.decision === "propose_issue") {
    const proposal = reply.issue_proposal ?? { title: "", body: "" };
    const quotedBody = proposal.body
      .split("\n")
      .slice(0, 3)
      .map((line) => `> ${normalizeJapaneseText(line)}`)
      .join("\n");
    return [
      ROLE_TAGS.pr_fix,
      normalizeJapaneseText(reply.body),
      "",
      `提案するIssue: ${normalizeJapaneseText(proposal.title)}`,
      quotedBody,
      "",
      "対応: Issue化を提案(承認待ち)",
    ].join("\n");
  }

  const disposition =
    reply.decision === "skipped"
      ? "見送り"
      : newSha === null
        ? "変更なし"
        : `\`${newSha.slice(0, 7)}\``;
  return [
    ROLE_TAGS.pr_fix,
    normalizeJapaneseText(reply.body),
    "",
    `対応: ${disposition}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// pr_fix_finish / issue_proposal_apply: `propose_issue` replies (user
// decision, 2026-09-26) — recording a candidate Issue for human
// approval/rejection.
// ---------------------------------------------------------------------------

/** The `FixReply`s Claude marked `"propose_issue"` this round — used by
 * pr_fix_finish.ts to decide how many `factory.issue_proposals` rows to
 * record and whether the round ends `needs_human` instead of
 * `rereview_requested`. */
export function selectProposeIssueReplies(
  replies: readonly FixReply[],
): FixReply[] {
  return replies.filter((reply) => reply.decision === "propose_issue");
}

/**
 * Finds the review thread containing `reviewCommentId` among `threads` —
 * used by pr_fix_finish.ts to attach a GraphQL thread id to a newly
 * recorded `propose_issue` row, so issue_proposal_apply.ts can resolve it
 * on approval. Matches on comment id (team-lead fix round, [MUST] #4 —
 * supersedes matching by `(path, line)`, which silently mismatched once a
 * later commit shifted the diff's line numbers): `thread.firstCommentDatabaseId`
 * covers the common case cheaply, `thread.allCommentIds` (first 50 comments
 * in the thread — see github.ts's `listReviewThreads`) covers a reply that
 * targets a later comment in the thread. `null` when no thread contains the
 * id — e.g. a plain issue comment, which has no review thread at all.
 */
export function matchReviewThreadForComment(
  threads: readonly ReviewThread[],
  reviewCommentId: number,
): string | null {
  const match = threads.find(
    (thread) =>
      thread.firstCommentDatabaseId === reviewCommentId ||
      thread.allCommentIds.includes(reviewCommentId),
  );
  return match?.id ?? null;
}

/** The Discord/status_reason text for a round that ends `needs_human`
 * because it recorded one or more pending issue proposals (user decision,
 * 2026-09-26) — matched by a `REASON_RULES` entry below so `describeReason`
 * (unchanged, since this text is already Japanese) and `nextActionFor`
 * (pointed at the Console Inbox) both handle it like every other
 * needs_human reason. */
export function buildIssueProposalReason(count: number): string {
  return `Issue化の提案が${String(count)}件あります`;
}

/**
 * Substitutes the literal `{{pr_url}}` placeholder in a fix's proposed
 * Issue body (fixPrompt's contract, prompts.ts) with the originating PR's
 * own URL, then appends a fixed footer noting the Issue's origin (user
 * decision, 2026-09-26). The footer has no half-width space between
 * "Issue"/"PR #<N>" and the adjoining Japanese characters, per this
 * project's writing-style rule.
 */
export function buildIssueProposalBody(
  bodyTemplate: string,
  prUrl: string,
  prNumber: number,
): string {
  const withUrl = bodyTemplate.split("{{pr_url}}").join(prUrl);
  // Claude's proposal text follows the same spacing rule as every other
  // factory-authored text once it becomes a GitHub Issue.
  return `${normalizeJapaneseText(withUrl)}\n\nこのIssueはPR #${String(prNumber)}のレビュー指摘から起票されました`;
}

/** Issue body for a proposal raised by an audit report (工程5): no PR to
 * link, the provenance line names the audited period instead. */
export function buildAuditProposalBody(
  bodyTemplate: string,
  periodLabel: string,
): string {
  return `${normalizeJapaneseText(bodyTemplate)}\n\nこのIssueは監査レポート(${periodLabel})から起票されました`;
}

/** The Issue title as created on GitHub: Claude's proposal title with the
 * ASCII/Japanese spacing rule applied. */
export function buildIssueProposalTitle(title: string): string {
  return normalizeJapaneseText(title.trim());
}

/** Renders the thread reply issue_proposal_apply.ts posts on approval —
 * the caller appends the `<!-- factory:pr_fix:<id> -->` marker via
 * github.ts's withMarker, same as renderFixReply's callers. */
export function renderIssueProposalApprovedReply(issueNumber: number): string {
  return [
    ROLE_TAGS.pr_fix,
    `Issue #${String(issueNumber)}を起票しました。`,
    "",
    `対応: Issue #${String(issueNumber)}`,
  ].join("\n");
}

/** Renders the thread reply issue_proposal_apply.ts posts on rejection —
 * same marker convention as renderIssueProposalApprovedReply. `reason` is
 * the human's own free text, passed through `normalizeJapaneseText`. */
export function renderIssueProposalRejectedReply(reason: string): string {
  return [
    ROLE_TAGS.pr_fix,
    "見送りとします。",
    `理由: ${normalizeJapaneseText(reason)}`,
    "",
    "対応: 見送り",
  ].join("\n");
}

// team-lead fix round, [MUST] #2: builder/parser pair for the
// `<!-- factory:issue_proposal:<id> -->` marker issue_proposal_apply.ts
// embeds in a created Issue's body, so a retried approve decision can find
// (and reuse) the Issue it already created via github.ts's
// `findIssueByMarker` instead of creating a duplicate.
const ISSUE_PROPOSAL_MARKER_KIND = "issue_proposal";

/** The inner marker phrase (no `<!-- -->` comment syntax) — passed to
 * `findIssueByMarker`'s quoted GitHub search, since the comment syntax's
 * `<`/`-`/`>` characters are noise to GitHub's search tokenizer. */
export function issueProposalMarkerSearchTerm(proposalId: number): string {
  return `factory:${ISSUE_PROPOSAL_MARKER_KIND}:${String(proposalId)}`;
}

/** The full `<!-- factory:issue_proposal:<id> -->` marker text embedded in a
 * created Issue's body. */
export function issueProposalMarkerText(proposalId: number): string {
  return `<!-- ${issueProposalMarkerSearchTerm(proposalId)} -->`;
}

/** Appends `issueProposalMarkerText`'s marker to a created Issue's body
 * (builder). */
export function appendIssueProposalMarker(
  body: string,
  proposalId: number,
): string {
  return `${body}\n\n${issueProposalMarkerText(proposalId)}`;
}

/** Whether `body` contains the exact marker for `proposalId` (parser) — used
 * to confirm a `findIssueByMarker` search hit before trusting it, since a
 * quoted GitHub search phrase is a word/substring match, not an exact
 * comparison (e.g. it could in principle also match a longer id containing
 * this one as a prefix). */
export function hasIssueProposalMarker(
  body: string,
  proposalId: number,
): boolean {
  return body.includes(issueProposalMarkerText(proposalId));
}

export type IssueProposalReplyTarget = "inline" | "issue_comment";

/**
 * Which GitHub reply mechanism issue_proposal_apply.ts should use for a
 * proposal's decision reply (team-lead fix round, [MUST] #4) — deterministic
 * from the row's own persisted `is_inline` flag, replacing a former
 * try-`replyReviewComment`-then-fallback-to-`postIssueComment` guess (the
 * row didn't used to record which kind its `review_comment_id` was).
 */
export function chooseIssueProposalReplyTarget(
  isInline: boolean,
): IssueProposalReplyTarget {
  return isInline ? "inline" : "issue_comment";
}

export type IssueProposalDecisionRow = {
  readonly status: IssueProposalStatus;
  readonly created_issue_number: number | null;
};

export type IssueProposalDecisionRequest = {
  readonly decision: "approve" | "reject";
  readonly reason: string;
  /** Not read by `classifyIssueProposalDecision` below (`IssueProposalDecisionRow`
   * carries no matching field) — a `repost_only` retry's own
   * `with_factory_label` never changes the classification. It also never
   * changes which label choice actually applies: issue_proposal_apply.ts's
   * approve path re-reads the row's already-stored `with_factory_label`
   * (the first approval's choice) when it resumes Issue creation on a
   * retry, not this field's value from the retry request. The stored choice
   * always wins. */
  readonly with_factory_label: boolean;
};

export type IssueProposalClassification =
  | { readonly action: "proceed" }
  | { readonly action: "repost_only" }
  /** The same decision was already recorded *and* every side effect
   * completed (the Issue exists): a harmless redispatch, to be treated as
   * a silent no_op rather than a failure. */
  | { readonly action: "already_done"; readonly created_issue_number: number }
  | { readonly action: "refuse"; readonly message: string };

/**
 * Classifies what issue_proposal_apply.ts's main() should do about a
 * proposal row it just read, before touching the DB or GitHub at all
 * (team-lead fix round, [MUST] #2 "Approve path must be idempotent" — pure,
 * for testing, mirrors approval_decide.ts's `classifyExistingApproval`):
 *
 *   - `"proceed"`: the row is still `pending` — this is a fresh decision.
 *   - `"repost_only"`: the row already carries the *same* decision as
 *     `requested`, but its side effects may not have completed (an approve
 *     whose Issue creation crashed before `created_issue_number` was
 *     written back) — main() must not attempt to record the decision again
 *     (`decideIssueProposal`'s own `WHERE status = 'pending'` guard would
 *     make that call a no-op anyway), but should still finish the rest of
 *     the flow (create-or-reuse the Issue, reply, resolve) idempotently.
 *   - `"refuse"`: either the row already carries a *different* decision than
 *     `requested` (a genuine conflict), or it carries the same decision and
 *     its side effects already completed (an approve whose Issue was
 *     already created) — nothing left to do, and doing it again would
 *     create a duplicate Issue/reply. `message` is a ready-to-throw Japanese
 *     sentence.
 */
export function classifyIssueProposalDecision(
  row: IssueProposalDecisionRow,
  requested: IssueProposalDecisionRequest,
): IssueProposalClassification {
  if (row.status === "pending") {
    return { action: "proceed" };
  }
  const requestedStatus =
    requested.decision === "approve" ? "approved" : "rejected";
  if (row.status !== requestedStatus) {
    const currentLabel = row.status === "approved" ? "承認" : "却下";
    const requestedLabel = requested.decision === "approve" ? "承認" : "却下";
    return {
      action: "refuse",
      message: `この提案は既に${currentLabel}として判断済みです(今回のリクエストは${requestedLabel})`,
    };
  }
  if (row.status === "approved" && row.created_issue_number !== null) {
    return {
      action: "already_done",
      created_issue_number: row.created_issue_number,
    };
  }
  return { action: "repost_only" };
}

export type IssueProposalStatusDecision =
  | { readonly action: "keep" }
  | {
      readonly action: "swap";
      readonly toStatus: "rereview_requested" | "reviewed";
    };

/**
 * Decides what issue_proposal_apply.ts should do to the work item's status
 * after recording one decision (user decision, 2026-09-26; 2026-09-27 PR
 * label cleanup: this used to also swap a PR state label off
 * `needs_human_label` — there is no state label any more, so this is now
 * purely a status decision): keep the current `needs_human` status while any
 * proposal for this work item is still pending, otherwise swap to
 * `rereview_requested` (a commit was pushed this round —
 * `factory.fix_rounds.commit_shas` non-empty) or `reviewed` (nothing was
 * pushed — the round that produced the proposal was itself a
 * `nothing_to_commit` round).
 */
export function decidePostProposalStatus(
  remainingPendingCount: number,
  committedThisRound: boolean,
): IssueProposalStatusDecision {
  if (remainingPendingCount > 0) {
    return { action: "keep" };
  }
  return {
    action: "swap",
    toStatus: committedThisRound ? "rereview_requested" : "reviewed",
  };
}

export type PostProposalTransition =
  | { readonly action: "keep" }
  | {
      readonly action: "swap";
      readonly expectedFrom: WorkItemStatus;
      readonly toStatus: WorkItemStatus;
    };

/** Kind-aware successor of decidePostProposalStatus: an audit waits in
 * `awaiting_approval` and ends in `audited`; a pr_fix waits in
 * `needs_human` and ends in rereview_requested / reviewed. */
export function decidePostProposalTransition(
  kind: WorkItemKind,
  remainingPendingCount: number,
  committedThisRound: boolean,
): PostProposalTransition {
  if (remainingPendingCount > 0) {
    return { action: "keep" };
  }
  if (kind === "audit") {
    return {
      action: "swap",
      expectedFrom: "awaiting_approval",
      toStatus: "audited",
    };
  }
  return {
    action: "swap",
    expectedFrom: "needs_human",
    toStatus: committedThisRound ? "rereview_requested" : "reviewed",
  };
}

// ---------------------------------------------------------------------------
// describeReason: display-only Japanese translation of a `reason` /
// `status_reason` string (team-lead follow-up). The `reason` recorded via
// updateStatusIfCurrent / addNotice must stay in its original English form —
// other tooling keys off it, and factory.notices/status_reason are meant to
// stay machine-comparable — but the *same* text shown in a GitHub comment or
// a Discord notification should read in Japanese like every other
// human-facing string the factory posts. `describeReason` maps every known
// guard/outcome reason string produced across pr_workflow_support.ts and the
// pr_fix_*/pipeline_*/pr_review_generate.ts step scripts to a Japanese
// sentence for *that display only*; callers keep passing the untranslated
// value to updateStatusIfCurrent/addNotice. A reason this function doesn't
// recognize — including Claude's own free-text `summary`/`blocked_reason` —
// is returned unchanged rather than silently dropped or garbled.
// ---------------------------------------------------------------------------

type ReasonRule = {
  readonly pattern: RegExp;
  readonly describe: (match: RegExpMatchArray) => string;
  // team-lead decision (2026-09-26): every reason a needs_human
  // notification carries must also tell the reader what to do about it —
  // `nextActionFor` below picks this per rule, the same way `describeReason`
  // picks `describe`. A concrete, one-sentence Japanese instruction; the
  // generic `GENERIC_NEXT_ACTION` fallback covers a reason with no specific
  // action of its own (e.g. a bare safety-guard failure) or one this table
  // doesn't recognize at all.
  readonly nextAction: (match: RegExpMatchArray) => string;
};

// team-lead decision (2026-09-26): pointed at the Console's own
// Failures/Notices tabs (factory_console__raw_app) — the one place every
// needs_human work item / notice is listed regardless of cause, so it's a
// safe default when no more specific action applies.
const GENERIC_NEXT_ACTION =
  "ConsoleのFailures / Noticesタブで詳細を確認してください";

const FACTORY_FIX_RELABEL_ACTION =
  "対応してほしい指摘をコメントしてから`factory:fix`を付け直してください";
const CHECK_COMMAND_NEXT_ACTION =
  "失敗しているチェックを確認し、人が修正してください";
const FORBIDDEN_CHANGE_NEXT_ACTION =
  "差分を確認し、問題なければ人が直接修正してください";
const DIFF_SIZE_NEXT_ACTION =
  "変更を分割するか、上限を見直してから`factory:fix`を付け直してください";
const DAILY_BUDGET_NEXT_ACTION =
  "翌日まで待つか、daily_budget_usdを引き上げてください";
const NOTHING_TO_COMMIT_NEXT_ACTION =
  "返信内容を確認し、必要なら指示をコメントして`factory:fix`を付け直してください";
const ISSUE_PROPOSAL_NEXT_ACTION =
  "ConsoleのInboxで提案を承認または却下してください";

const REASON_RULES: readonly ReasonRule[] = [
  // pr_fix_prepare.ts's evaluatePrFixSafetyGuards / evaluateRepoAllowedGuard
  {
    pattern: /^pull request is not open$/,
    describe: () => "PR がオープンではありません",
    nextAction: () => "PRを再オープンするか、この作業を取り下げてください",
  },
  {
    pattern: /^head repository differs from base repository \(fork PR\)$/,
    describe: () => "head リポジトリと base リポジトリが異なります(fork PR)",
    nextAction: () =>
      "forkではなく同一リポジトリのブランチからPRを作り直してください",
  },
  {
    pattern: /^pull request is a draft$/,
    describe: () => "PR がドラフトです",
    nextAction: () => "ドラフトを解除してから`factory:fix`を付け直してください",
  },
  {
    pattern: /^base branch is protected$/,
    describe: () => "base ブランチが保護されています",
    nextAction: () => "baseブランチの保護設定を確認してください",
  },
  {
    pattern:
      /^repository is not allowed by factory_config \(owners \/ repo_allowlist\)$/,
    describe: () =>
      "factory_config(owners / repo_allowlist)で許可されていないリポジトリです",
    nextAction: () =>
      "factory_configのowners / repo_allowlistを見直してください",
  },
  // pr_fix_prepare.ts's evaluateFixRoundGuard (round_exhausted)
  {
    pattern: /^fix_round (\d+) exceeds max_fix_rounds (\d+)$/,
    describe: (m) => `fix_round ${m[1]} が max_fix_rounds ${m[2]} を超えました`,
    nextAction: () => "残りの指摘は人が対応するか、上限を見直してください",
  },
  // pr_fix_collect.ts (no_feedback)
  {
    pattern:
      /^no actionable feedback since the last processed review\/comment$/,
    describe: () =>
      "前回処理したレビュー・コメント以降、対応可能なフィードバックがありません",
    nextAction: () => FACTORY_FIX_RELABEL_ACTION,
  },
  // pr_fix_verify.ts's detectForbiddenChanges / detectEscapingSymlinks /
  // detectSymlinkChanges / evaluateDiffSizeGuard (forbidden paths /
  // symlink_change / diff size)
  {
    pattern: /^forbidden path changed: (.+)$/,
    describe: (m) => `変更が禁止されたパスです: ${m[1]}`,
    nextAction: () => FORBIDDEN_CHANGE_NEXT_ACTION,
  },
  {
    pattern: /^new shell script added: (.+)$/,
    describe: (m) => `新しいシェルスクリプトが追加されました: ${m[1]}`,
    nextAction: () => FORBIDDEN_CHANGE_NEXT_ACTION,
  },
  {
    pattern: /^package\.json "scripts" field changed$/,
    describe: () => "package.jsonの`scripts`が変更されました",
    nextAction: () => FORBIDDEN_CHANGE_NEXT_ACTION,
  },
  {
    pattern: /^symlink escapes the worktree: (.+) -> (.+)$/,
    describe: (m) =>
      `シンボリックリンクが worktree の外を指しています: ${m[1]} -> ${m[2]}`,
    nextAction: () => FORBIDDEN_CHANGE_NEXT_ACTION,
  },
  {
    pattern: /^symlink_change: symlink changed: (.+)$/,
    describe: (m) =>
      `symlink_change: シンボリックリンクが変更されました: ${m[1]}`,
    nextAction: () => FORBIDDEN_CHANGE_NEXT_ACTION,
  },
  {
    pattern:
      /^symlink_change: file type changed \(possible symlink conversion\): (.+)$/,
    describe: (m) =>
      `symlink_change: ファイル種別が変更されました(シンボリックリンクへの変換の可能性): ${m[1]}`,
    nextAction: () => FORBIDDEN_CHANGE_NEXT_ACTION,
  },
  {
    pattern: /^changed file count (\d+) exceeds (\S+) (\d+)$/,
    describe: (m) => `変更ファイル数 ${m[1]} が ${m[2]} ${m[3]} を超えました`,
    nextAction: () => DIFF_SIZE_NEXT_ACTION,
  },
  {
    pattern: /^diff line total (\d+) exceeds (\S+) (\d+)$/,
    describe: (m) => `diff の総行数 ${m[1]} が ${m[2]} ${m[3]} を超えました`,
    nextAction: () => DIFF_SIZE_NEXT_ACTION,
  },
  // pr_fix_apply.ts / pr_fix_verify.ts / pipeline_generate.ts /
  // pr_review_generate.ts's daily-budget guard (budget exceeded)
  {
    pattern: /^daily budget exceeded \(\$([\d.]+) >= \$([\d.]+)\)$/,
    describe: (m) =>
      `1 日あたりの Claude 利用予算の上限に達しました($${m[1]} >= $${m[2]})`,
    nextAction: () => DAILY_BUDGET_NEXT_ACTION,
  },
  {
    pattern: /^daily budget exceeded$/,
    describe: () => "1 日あたりの Claude 利用予算の上限に達しました",
    nextAction: () => DAILY_BUDGET_NEXT_ACTION,
  },
  // pr_fix_finish.ts's push / retry outcomes (head_changed, etc.)
  {
    pattern: /^PR head moved to (\S+) while the fix was in progress$/,
    describe: (m) => `修正の実行中に PR の head が ${m[1]} に変わりました`,
    nextAction: () =>
      "最新のheadを確認し、必要なら`factory:fix`を付け直してください",
  },
  // The implement flow's push (工程3 design §3): a fine-grained PAT without
  // the `workflow` scope cannot push a commit touching .github/workflows/**.
  // GitHub's rejection text sits inside git's stderr, so this pattern is
  // deliberately unanchored (the reason carries the whole push error).
  {
    pattern:
      /refusing to allow a Personal Access Token to create or update workflow/,
    describe: () =>
      "PATに`workflow`スコープが無いため、`.github/workflows/**`を含むpushが拒否されました",
    nextAction: () =>
      "PATにWorkflows(Read and write)権限を追加するか、ワークフローファイルの変更を人がpushしてください",
  },
  {
    pattern: /^check-fix retry pass failed \((.+)\): (.+)$/,
    describe: (m) =>
      `チェック失敗後の自動修正リトライに失敗しました(${m[1]}): ${m[2]}`,
    nextAction: () => CHECK_COMMAND_NEXT_ACTION,
  },
  {
    pattern: /^repository checks still failing after one automated fix retry$/,
    describe: () => "自動修正の再試行後もリポジトリのチェックに失敗しています",
    nextAction: () => CHECK_COMMAND_NEXT_ACTION,
  },
  {
    pattern: /^done outcome missing a commit message$/,
    describe: () =>
      "完了と報告されましたが、コミットメッセージがありませんでした",
    nextAction: () => "もう一度`factory:fix`を付け直してください",
  },
  // team-lead fix: pr_fix_finish.ts's nothing_to_commit branch now also
  // posts the queued replies, so its Discord reason records both halves
  // (describeReason recurses over a "; "-joined list — see the module note
  // above — so each half is matched and translated independently here).
  // nextActionFor (below) only ever needs the first segment's action, since
  // "no changes to commit" always precedes "replies posted" in that joined
  // reason — both share the same next action for that reason.
  {
    pattern: /^no changes to commit$/,
    describe: () => "コミットする変更がありませんでした",
    nextAction: () => NOTHING_TO_COMMIT_NEXT_ACTION,
  },
  {
    pattern: /^replies posted$/,
    describe: () => "返信は投稿済みです",
    nextAction: () => NOTHING_TO_COMMIT_NEXT_ACTION,
  },
  // pr_fix_finish.ts's buildIssueProposalReason (user decision, 2026-09-26):
  // already Japanese, so describe() returns it unchanged — this rule exists
  // so nextActionFor still points at the Console Inbox instead of the
  // generic fallback.
  {
    pattern: /^Issue化の提案が(\d+)件あります$/,
    describe: (m) => `Issue化の提案が${m[1]}件あります`,
    nextAction: () => ISSUE_PROPOSAL_NEXT_ACTION,
  },
  {
    pattern: /^needs human attention$/,
    describe: () => "人による対応が必要です",
    nextAction: () => GENERIC_NEXT_ACTION,
  },
  {
    pattern: /^safety guard failed$/,
    describe: () => "安全性ガードに失敗しました",
    nextAction: () => GENERIC_NEXT_ACTION,
  },
  // pr_fix_finish.ts's evaluateRerouteGuard (no parent issue_number)
  {
    pattern: /^parent work item has no issue_number$/,
    describe: () => "親の work item に issue_number がありません",
    nextAction: () => "work itemの状態をConsoleで確認してください",
  },
  // requirements_apply.ts's rejected/needs_human outcome and
  // poll_issues.ts's expiry sweep
  {
    pattern: /^rejected (\d+) times$/,
    describe: (m) => `${m[1]} 回連続で差し戻されました`,
    nextAction: () =>
      "要件を人が整理し、Issueに追記してから`factory`ラベルを付け直してください",
  },
  {
    pattern: /^approval timed out$/,
    describe: () => "承認がタイムアウトしました",
    nextAction: () => "Inboxで承認または却下してください",
  },
  // pr_fix_finish.ts's post-push reviewer-request outcome (reviewerNote) —
  // team-lead decision (2026-09-26): none of these three reach a
  // needs_human notification anymore (skipped_empty / no candidates post no
  // notification at all; failed folds into the pr_fixed event's own `note`
  // field instead — see pr_fix_finish.ts), so their nextAction is
  // exercised only through describeReason/nextActionFor directly (e.g. in
  // tests), not through a live Discord notification.
  {
    pattern:
      /^no reviewers to request \(default_reviewers empty and no fallback reviewer authors\)$/,
    describe: () =>
      "リクエストするレビュアーがいません(default_reviewers が空で、フォールバックの候補者もいません)",
    nextAction: () =>
      "default_reviewersを設定するか、レビュー履歴を確認してください",
  },
  {
    pattern: /^failed to request reviewers: (.+)$/,
    describe: (m) => `レビュアーのリクエストに失敗しました: ${m[1]}`,
    nextAction: () =>
      "GitHubのレビュアー設定を確認し、必要なら再度`factory:fix`を付け直してください",
  },
  {
    pattern:
      /^requested reviewers were all excluded \(PR author \/ factory viewer\)$/,
    describe: () =>
      "リクエスト対象のレビュアーが全員除外されました(PR 作成者 / factory 自身)",
    nextAction: () =>
      "default_reviewersにPR作成者以外のレビュアーを設定してください",
  },
  {
    pattern: /^could not request re-review: (.+)$/,
    describe: (m) =>
      `再レビューをリクエストできませんでした: ${describeReason(m[1] ?? "")}`,
    nextAction: (m) => nextActionFor(m[1] ?? ""),
  },
];

/**
 * Maps one factory-authored `reason`/`status_reason` string to Japanese for
 * display in a GitHub comment or Discord notification (pure, for testing) —
 * see the module note above. Recurses over a `"; "`-joined list
 * (pr_fix_verify.ts's `ForbiddenChangeResult.reasons.join("; ")`) so each
 * entry is translated independently; an entry (or the whole string) this
 * function doesn't recognize is returned unchanged.
 */
/**
 * The result fields for an early exit (skip / guard_blocked /
 * round_exhausted). The PR coordinates are always taken from the work
 * item: pr_fix_finish.ts needs owner / repo / pr_number to address the
 * Discord notification even when no worktree was prepared (a real run once
 * left a notification with an empty "リポジトリ" field because these were
 * blank).
 */
export function earlyExitBase(
  workItem: Pick<
    WorkItem,
    | "owner"
    | "repo"
    | "pr_number"
    | "head_sha"
    | "parent_work_item_id"
    | "attempt"
    | "fix_round"
  >,
): {
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
  readonly head_sha: string;
  readonly worktree_dir: string;
  readonly repo_dir: string;
  readonly factory_clone_dir: string;
  readonly parent_work_item_id: number | null;
  readonly attempt: number;
  readonly fix_round: number;
} {
  return {
    owner: workItem.owner,
    repo: workItem.repo,
    pr_number: workItem.pr_number ?? 0,
    head_sha: workItem.head_sha ?? "",
    worktree_dir: "",
    repo_dir: "",
    factory_clone_dir: "",
    parent_work_item_id: workItem.parent_work_item_id,
    attempt: workItem.attempt,
    fix_round: workItem.fix_round,
  };
}

export function describeReason(reason: string): string {
  if (reason.includes("; ")) {
    return reason.split("; ").map(describeReason).join("; ");
  }
  for (const rule of REASON_RULES) {
    const match = reason.match(rule.pattern);
    if (match !== null) {
      // Translations are user-facing text, so the same ASCII/Japanese
      // spacing rule as posted comments applies to them.
      return normalizeJapaneseText(rule.describe(match));
    }
  }
  return reason;
}

/**
 * Picks the concrete "次の操作" instruction for a `reason`/`status_reason`
 * string (team-lead decision, 2026-09-26) — used by every needs_human
 * NotifyEvent emitter (pr_fix_finish.ts, pr_review_generate.ts,
 * requirements_apply.ts, pipeline_generate.ts, poll_issues.ts's expiry
 * sweep) alongside `describeReason`.
 * Unlike `describeReason`, this does not translate/join every "; "-joined
 * segment — it returns the *first* segment's matching rule's action (the
 * segment order in every producer here places the primary, actionable
 * reason first; see the module note on the `"no changes to commit; replies
 * posted"` pair above), falling back to `GENERIC_NEXT_ACTION` when no
 * segment matches any rule.
 */
export function nextActionFor(reason: string): string {
  const segments = reason.includes("; ") ? reason.split("; ") : [reason];
  for (const segment of segments) {
    for (const rule of REASON_RULES) {
      const match = segment.match(rule.pattern);
      if (match !== null) {
        return rule.nextAction(match);
      }
    }
  }
  return GENERIC_NEXT_ACTION;
}

// ---------------------------------------------------------------------------
// I/O: git helpers not exposed by workspace.ts
// ---------------------------------------------------------------------------

function gitHardeningArgv(extra: readonly string[]): string[] {
  return [
    "git",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "credential.helper=",
    ...extra,
  ];
}

function resolvedEnv(
  base: Record<string, string>,
  home: string | undefined,
  path: string | undefined,
): Record<string, string> {
  const env = { ...base };
  const resolvedHome = home ?? process.env.HOME;
  if (resolvedHome !== undefined) env.HOME = resolvedHome;
  const resolvedPath = path ?? process.env.PATH;
  if (resolvedPath !== undefined) env.PATH = resolvedPath;
  return env;
}

export type ReadFileFn = (path: string) => Promise<string>;

const defaultReadTextFile: ReadFileFn = (path) => Bun.file(path).text();

/** Reads a worktree file directly (not via git), returning `null` if it
 * doesn't exist (e.g. Claude deleted it) rather than throwing. */
export async function readWorktreeFileIfExists(
  path: string,
  readFile: ReadFileFn = defaultReadTextFile,
): Promise<string | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

// team-lead fix round 2 item a: getBranchProtected / postIssueComment /
// setHeadSha / fetchPrHeadRef / readGitShowFile were promoted verbatim into
// lib/github.ts, lib/db.ts, and lib/workspace.ts (same signatures) — this
// file's local copies (and their now-dead gh-api-response-parsing support
// code) are removed; callers import the lib versions instead.
