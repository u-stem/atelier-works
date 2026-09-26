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
// NOTE: addLabels was this file's own local duplicate too, promoted into
// lib/github.ts mid-cycle (team-lead re-gate's "defer promotion" note
// predates it) — see the addLabels section below for where it used to live.

import { mkdtemp, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { type GhClient, removeLabel } from "../lib/github.ts";
import { type Logger, maskSecrets } from "../lib/log.ts";
import { isFactoryFixCommand } from "../lib/poll_support.ts";
import {
  type FixOutcome,
  type FixReply,
  isNumber,
  isOneOf,
  isRecord,
  isString,
  type LabelerAssociation,
  type ReviewFinding,
  type ReviewSeverity,
  type ReviewVerdict,
  type WorkItem,
} from "../lib/types.ts";
import type { CommandRunner } from "../lib/workspace.ts";

// ---------------------------------------------------------------------------
// Shared: terminal-transition label cleanup (I/O)
// ---------------------------------------------------------------------------

/**
 * Removes each of `labels` from the PR on a terminal status transition
 * (team-lead rule, 2026-09-26: alongside `wip_label`, also remove the
 * trigger label — `review_label` / `fix_label` — that started this cycle,
 * if a human re-applies it later that's what should trigger a fresh
 * cycle). Idempotent both ways: github.ts's `removeLabel` itself treats an
 * already-absent label (404) as a no-op, and any other failure here is
 * swallowed (logged, not thrown) — cleaning up a label must never fail the
 * step that already committed the status transition.
 */
export async function removeTerminalLabels(
  client: GhClient,
  owner: string,
  repo: string,
  number: number,
  labels: readonly string[],
  log: Logger,
): Promise<void> {
  for (const label of labels) {
    try {
      await removeLabel(client, owner, repo, number, label);
    } catch (err) {
      log.warn("failed to remove label on terminal transition", {
        label,
        error: maskSecrets(err instanceof Error ? err.message : String(err)),
      });
    }
  }
}

// addLabels (used by pr_fix_finish.ts's requirements_gap reroute — see its
// call site for why) was this file's own thin `gh api` copy at first, then
// promoted into lib/github.ts mid-cycle (same signature/behavior); callers
// import it from there now instead of a local duplicate.

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

export type ReviewClaudeOutput = {
  readonly verdict: ReviewVerdict;
  readonly summary: string;
  readonly findings: ReviewFinding[];
};

function isReviewFindingShape(value: unknown): value is ReviewFinding {
  if (!isRecord(value)) return false;
  if (!isString(value.path)) return false;
  if (value.line !== null && !isNumber(value.line)) return false;
  if (!isOneOf(value.severity, REVIEW_SEVERITIES)) return false;
  if (!isString(value.message)) return false;
  if (value.suggestion !== null && !isString(value.suggestion)) return false;
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
  readonly body: string;
};

/** Maps findings to GitHub inline review comments, dropping any finding
 * whose `path` is not among the PR's changed files (GitHub rejects an
 * inline comment on a path outside the diff) or whose `line` can't anchor
 * one (`null` or non-positive). */
export function mapFindingsToReviewComments(
  findings: readonly ReviewFinding[],
  prFiles: readonly string[],
): { readonly comments: ReviewCommentLike[]; readonly droppedCount: number } {
  const fileSet = new Set(prFiles);
  const comments: ReviewCommentLike[] = [];
  let droppedCount = 0;
  for (const finding of findings) {
    if (
      finding.line === null ||
      finding.line <= 0 ||
      !fileSet.has(finding.path)
    ) {
      droppedCount += 1;
      continue;
    }
    comments.push({
      path: finding.path,
      line: finding.line,
      side: "RIGHT",
      body: formatFindingBody(finding),
    });
  }
  return { comments, droppedCount };
}

function formatFindingBody(finding: ReviewFinding): string {
  const suggestion =
    finding.suggestion !== null ? `\n\nSuggestion: ${finding.suggestion}` : "";
  return `**[${finding.severity}]** ${finding.message}${suggestion}`;
}

/** Composes the top-level review comment body: summary + verdict line +
 * a note when some findings couldn't be posted inline. The caller appends
 * the `<!-- factory:pr_review:<id> -->` marker via github.ts's withMarker. */
export function buildReviewBody(
  summary: string,
  verdict: ReviewVerdict,
  totalFindings: number,
  droppedCount: number,
): string {
  const verdictLine = `**Verdict:** ${verdict}`;
  const note =
    droppedCount > 0
      ? `\n\n_${String(droppedCount)} of ${String(totalFindings)} finding(s) could not be posted as inline comments (file outside this PR's diff, or no line reference) — see this review's summary above._`
      : "";
  return `${summary}\n\n${verdictLine}${note}`;
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

/** Plain issue-level comments, excluding the `/factory fix` trigger command
 * itself (that's a trigger, not feedback) and any author outside
 * `allowedAssociations` — github.ts's `listIssueComments` already filters
 * to human, non-marker comments newer than the `last_comment_id` watermark
 * (`opts.sinceId`), so this only needs the pr_fix-specific exclusions. */
export function selectNewIssueComments(
  comments: readonly RawIssueComment[],
  allowedAssociations: readonly LabelerAssociation[],
): SelectResult<CollectedComment> {
  const items: CollectedComment[] = [];
  const excludedAuthors: string[] = [];
  for (const comment of comments) {
    if (isFactoryFixCommand(comment.body)) continue;
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
// pr_fix_apply: commit message synthesis (pure)
// ---------------------------------------------------------------------------

const COMMIT_SUBJECT_MAX = 72;

/** prompts.ts's FIX_SCHEMA has no `commit_message` field (unlike
 * .claude/skills/factory-fix's own, out-of-date, schema section — see the
 * implementer's report) — Claude never proposes one. This derives a
 * Conventional-Commits subject line from Claude's own `summary` field
 * instead, deterministically, so pr_fix_finish never needs to trust
 * untrusted free text as a literal commit subject beyond this. */
export function buildFixCommitMessage(summary: string, round: number): string {
  const firstLine = (summary.split("\n")[0] ?? "").trim();
  const subject =
    firstLine.length > 0
      ? firstLine
      : `address round ${String(round)} review feedback`;
  const truncated =
    subject.length > COMMIT_SUBJECT_MAX
      ? `${subject.slice(0, COMMIT_SUBJECT_MAX - 1)}…`
      : subject;
  return `fix: ${truncated}`;
}

// ---------------------------------------------------------------------------
// pr_fix_apply: Claude structured-output type guard (pure)
// ---------------------------------------------------------------------------

const FIX_OUTCOMES: readonly FixOutcome[] = [
  "done",
  "requirements_gap",
  "blocked",
];

export type FixClaudeOutput = {
  readonly outcome: FixOutcome;
  readonly summary: string;
  readonly replies: FixReply[];
  readonly blocked_reason: string | null;
};

function isFixReplyShape(value: unknown): value is FixReply {
  return (
    isRecord(value) && isNumber(value.review_comment_id) && isString(value.body)
  );
}

/** Matches prompts.ts's FIX_SCHEMA exactly (see isReviewClaudeOutput's note
 * on the same divergence from .claude/skills/factory-fix's own schema
 * section: no `commit_message`/`gap_report`, but a `blocked_reason` used
 * for both the "blocked" and "requirements_gap" outcomes). */
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
  return true;
}

// ---------------------------------------------------------------------------
// pr_fix_verify: forbidden-change detection (pure) — docs/security.md
// "pr_fix の安全策"
// ---------------------------------------------------------------------------

export type ChangedPathStatus =
  | "added"
  | "modified"
  | "deleted"
  | "typechange"
  | "unknown";

export type ChangedPath = {
  readonly path: string;
  readonly status: ChangedPathStatus;
};

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

// team-lead fix round 1b item 5: widened from the original .claude/**,
// .agents/**, mise.toml, mise.*.toml, lefthook.yml, .github/workflows/** —
// covers every other config surface that changes which commands run or
// what a package manager/git trusts (mise's XDG/dotfile config locations,
// lefthook's alternate formats and machine-local override, bunfig.toml's
// install/registry settings, .npmrc's registry/auth settings, and
// .gitattributes/.gitmodules, which can redirect git filters/submodule
// URLs).
const FORBIDDEN_PATH_PREFIXES: readonly string[] = [
  ".claude/",
  ".agents/",
  ".github/workflows/",
  ".mise/",
  ".config/mise/",
  ".lefthook/",
];

const FORBIDDEN_BASENAME_PATTERNS: readonly RegExp[] = [
  /^mise\.toml$/,
  /^mise\..*\.toml$/,
  /^\.mise\.toml$/,
  /^lefthook\.yml$/,
  /^lefthook-local\.yml$/,
  /^lefthook\.toml$/,
  /^lefthook\.json$/,
  /^bunfig\.toml$/,
  /^\.npmrc$/,
  /^\.gitattributes$/,
  /^\.gitmodules$/,
];

/** docs/security.md "変更してはいけないファイル", widened per team-lead fix
 * round 1b item 5 — see FORBIDDEN_PATH_PREFIXES / FORBIDDEN_BASENAME_PATTERNS
 * above for the full list. Directory entries match by repo-root-relative
 * path prefix; single-file entries match by basename regardless of which
 * directory they appear in. */
export function matchesForbiddenPath(path: string): boolean {
  const normalized = path.replace(/^\.\//, "");
  for (const prefix of FORBIDDEN_PATH_PREFIXES) {
    if (normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)) {
      return true;
    }
  }
  const basename = normalized.split("/").pop() ?? normalized;
  return FORBIDDEN_BASENAME_PATTERNS.some((pattern) => pattern.test(basename));
}

export function isNewShellScript(entry: ChangedPath): boolean {
  return entry.status === "added" && /\.sh$/i.test(entry.path);
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

/** Blocks when the changed-file count or the total added+deleted line count
 * exceeds factory_config's configured ceiling. `changedFileCount` is the
 * caller's already-computed status+diff-name-only union (the same set the
 * forbidden-path check uses) rather than a second file count derived from
 * numstat alone, since numstat doesn't list untracked (newly added) files
 * that `git status --porcelain` does. */
export function evaluateDiffSizeGuard(
  changedFileCount: number,
  diffLineTotal: number,
  maxChangedFiles: number,
  maxDiffLines: number,
): string[] {
  const reasons: string[] = [];
  if (changedFileCount > maxChangedFiles) {
    reasons.push(
      `changed file count ${String(changedFileCount)} exceeds max_fix_changed_files ${String(maxChangedFiles)}`,
    );
  }
  if (diffLineTotal > maxDiffLines) {
    reasons.push(
      `diff line total ${String(diffLineTotal)} exceeds max_fix_diff_lines ${String(maxDiffLines)}`,
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
};

const CHECK_OUTPUT_TAIL_CHARS = 2000;

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
      const result = await run(argv, { cwd, env, timeoutMs });
      const combined = `${result.stdout}\n${result.stderr}`.trim();
      results.push({
        command,
        ok: !result.timedOut && result.exitCode === 0,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        outputTail: maskSecrets(combined.slice(-CHECK_OUTPUT_TAIL_CHARS)),
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
 * Whether the parent issue's wip + trigger labels could not be re-applied
 * before a requirements_gap reroute — pure, so the abort-vs-proceed
 * decision itself is unit-testable without faking GitHub I/O (the actual
 * `addLabels` call/catch stays in pr_fix_finish.ts's main()). Either the
 * parent work item has no `issue_number` to label at all, or the
 * `addLabels` call itself failed (its caught, already-`maskSecrets`'d error
 * message) — both are treated the same way: DA re-verification (fix round
 * 2 follow-up) found that swallowing this failure and proceeding to
 * `runFlowAsync` anyway leaves the parent issue without its trigger label,
 * so poll_issues's reconcile (every 5 minutes) cancels the very pipeline
 * this step just started.
 */
export function evaluateRelabelFailure(
  issueNumber: number | null,
  addLabelsErrorMessage: string | null,
): string | null {
  if (issueNumber === null) return "parent work item has no issue_number";
  return addLabelsErrorMessage;
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
