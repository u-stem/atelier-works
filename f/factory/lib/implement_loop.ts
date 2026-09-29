// The implement flow's (工程3 design §2) shared contract and verify loop:
// the ImplementContext implement_prepare hands to every later step, the
// branch/worktree preparation order, the per-run doc_dir copy, one Claude
// run turned into an ImplementClaudeRound (generate and every fix round),
// and runImplementVerifyLoop with every I/O injected so it is unit-testable
// and reusable by pr_fix later. lib never imports steps: the verify step
// binds the steps-side helpers (diff-size guard, change listing, symlink
// detection) into ImplementLoopDeps.

import { access, cp, lstat, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunClaudeOptions, RunClaudeResult } from "./claude.ts";
import {
  classifyProtectedChanges,
  decideImplementRoundExit,
  IMPLEMENT_CHECK_SKIP_REASONS,
  type ImplementCheckSummary,
  type ImplementClaudeOutput,
  isImplementClaudeOutput,
  roundOutcomeForExit,
  stallHash,
  truncateCheckOutput,
  validateImplementOutput,
} from "./implement_support.ts";
import {
  type CheckFailure,
  IMPLEMENT_SCHEMA,
  type ImplementPromptInput,
} from "./prompts.ts";
import type { ChangedPath } from "./protected_paths.ts";
import type {
  AgentRunRecord,
  Diagram,
  FactoryConfig,
  ImplementDiffStat,
  ImplementRoundMode,
  ImplementRoundRecord,
} from "./types.ts";
import {
  type CommandRunner,
  type GitleaksResult,
  type WorktreeFingerprint,
  WorktreeGitPointerModifiedError,
} from "./workspace.ts";

export const IMPLEMENT_FLOW_PATH = "f/factory/implement";
export const IMPLEMENT_SKILL_NAME = "factory-implementation";

// ---------------------------------------------------------------------------
// Flow contract (implement_prepare's result, read by every later step)
// ---------------------------------------------------------------------------

/** `proceed` runs generate/verify; the others go straight to finish. */
export type ImplementPrepareOutcome =
  | "proceed"
  | "skip"
  | "cancelled"
  | "needs_human";
export const IMPLEMENT_PREPARE_OUTCOMES: readonly ImplementPrepareOutcome[] = [
  "proceed",
  "skip",
  "cancelled",
  "needs_human",
];

/** Everything later steps need, built once by implement_prepare. snake_case:
 * it crosses the flow as JSON, like every other step result. */
export type ImplementContext = {
  readonly owner: string;
  readonly repo: string;
  readonly issue_number: number;
  readonly issue_url: string;
  readonly issue_title: string;
  readonly issue_body: string;
  /** `factory/issue-<N>-wi-<id>` (buildImplementBranchName). */
  readonly branch: string;
  /** The repo's default branch — the PR base. */
  readonly base_branch: string;
  /** `git merge-base origin/<base_branch> HEAD` once the worktree was
   * ready: every round's change listing and diff size are measured against
   * it, so commits made earlier on the branch stay visible. */
  readonly base_sha: string;
  readonly repo_dir: string;
  readonly worktree_dir: string;
  readonly factory_clone_dir: string;
  /** origin/<branch> when prepare finished — commitAndPush's expectedHeadSha. */
  readonly expected_head_sha: string;
  readonly existing_pr_number: number | null;
  readonly existing_pr_url: string | null;
  /** Prepare-time value (design §13): an open PR, work_items.pr_url, or a
   * branch already ahead of base_sha. */
  readonly has_previous_implementation: boolean;
  readonly attempt: number;
  readonly requirements_markdown: string;
  readonly requirements_diagrams: Diagram[];
  /** The approved draft's directory; never mounted itself — every Claude
   * run gets a fresh copy (withReadOnlyDocDirCopy). */
  readonly requirements_doc_dir: string | null;
  readonly requirements_console_url: string;
  /** Only then does the PR body carry the Windmill deploy checklist. */
  readonly is_factory_repo: boolean;
  /** `<worktree_dir>/.git`'s bytes right after the worktree was ready
   * (readWorktreeGitPointer). Every later git command in the worktree is
   * preceded by assertWorktreeGitPointer against it: a Claude run that
   * rewrote `.git` could point git at a gitdir whose config runs commands. */
  readonly worktree_git_pointer: string;
};

/** implementPrompt / implementFixPrompt's shared input. The approved
 * markdown is inlined (fenced) by the prompt; `docDir` is the per-run copy
 * of doc_dir (or null) — the path the prompt names and addDirs mounts. */
export function implementPromptInput(
  context: ImplementContext,
  docDir: string | null,
): ImplementPromptInput {
  return {
    issue: {
      owner: context.owner,
      repo: context.repo,
      number: context.issue_number,
      title: context.issue_title,
      body: context.issue_body,
      url: context.issue_url,
    },
    requirements: {
      markdown: context.requirements_markdown,
      diagrams: context.requirements_diagrams,
      doc_dir: docDir,
    },
    worktreeDir: context.worktree_dir,
    branch: context.branch,
    hasPreviousImplementation: context.has_previous_implementation,
  };
}

// ---------------------------------------------------------------------------
// Branch and worktree preparation order (design §0b)
// ---------------------------------------------------------------------------

export type WorktreePrepDeps = {
  /** Whether `git worktree list` already has a worktree on the branch. */
  readonly hasWorktree: () => Promise<boolean>;
  /** createGtrWorktree(...).path */
  readonly createWorktree: () => Promise<string>;
  /** pushNewBranch(...).pushed — false when origin already had the branch. */
  readonly publishBranch: () => Promise<boolean>;
};

/**
 * The implement worktree, published on origin and aligned with it.
 * Measured with git gtr 2.11.1: `gtr new` reuses an existing local branch,
 * otherwise checks out origin/<branch> with upstream when only the remote
 * has it, otherwise branches from origin/<default>; createGtrWorktree's
 * reuse path (fetch → reset --hard origin/<branch> → clean) covers a branch
 * that already has a worktree. So: an existing worktree is published first
 * (a previous run may have died between `gtr new` and the empty push, and
 * the reuse path fetches origin/<branch>), then reused. A new one is
 * created and published; when origin already had the branch it is taken
 * once more through the reuse path, which aligns a stale local branch with
 * origin.
 */
export async function prepareImplementWorktree(
  deps: WorktreePrepDeps,
): Promise<string> {
  if (await deps.hasWorktree()) {
    await deps.publishBranch();
    return deps.createWorktree();
  }
  const created = await deps.createWorktree();
  if (await deps.publishBranch()) return created;
  return deps.createWorktree();
}

// ---------------------------------------------------------------------------
// withReadOnlyDocDirCopy: the approved requirements files are never mounted
// themselves (design §13: `--add-dir` paths may be writable)
// ---------------------------------------------------------------------------

export type DocDirCopyDeps = {
  /** `false` when the approved document is no longer on disk (worker
   * recreated, old draft) — the prompt still carries the markdown, so the
   * run proceeds without `--add-dir`. */
  readonly pathExists: (path: string) => Promise<boolean>;
  readonly makeTempDir: () => Promise<string>;
  readonly copyDir: (source: string, destination: string) => Promise<void>;
  readonly removeDir: (path: string) => Promise<void>;
};

type DocEntryStats = {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

/** isCopyableDocEntry's fs calls; injectable for tests. */
export type DocEntryFs = {
  readonly lstat: (path: string) => Promise<DocEntryStats>;
  readonly stat: (path: string) => Promise<DocEntryStats>;
};

const defaultDocEntryFs: DocEntryFs = {
  lstat: (path) => lstat(path),
  stat: (path) => stat(path),
};

/** The doc_dir copy's filter: regular files and real directories, and a
 * symlink only when it resolves to a regular file (copied as that file's
 * content — `dereference: true`). A symlink to a directory (which could
 * pull in an arbitrary tree), a dangling one, and anything that is not a
 * file or directory (FIFO, socket, device) are skipped, so the copy holds
 * no link a Claude `Write` could follow out of it. */
export async function isCopyableDocEntry(
  path: string,
  fs: DocEntryFs = defaultDocEntryFs,
): Promise<boolean> {
  const own = await fs.lstat(path);
  if (own.isFile() || own.isDirectory()) return true;
  if (!own.isSymbolicLink()) return false;
  try {
    return (await fs.stat(path)).isFile();
  } catch {
    return false;
  }
}

export const defaultDocDirCopyDeps: DocDirCopyDeps = {
  pathExists: (path) =>
    access(path).then(
      () => true,
      () => false,
    ),
  makeTempDir: () => mkdtemp(join(tmpdir(), "factory-requirements-")),
  copyDir: (source, destination) =>
    cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: (entry) => isCopyableDocEntry(entry),
    }),
  removeDir: (path) => rm(path, { recursive: true, force: true }),
};

/** Runs `fn` with a fresh copy of `docDir` (`<tmp>/requirements`), removed
 * afterwards whether `fn` succeeds or throws. Whatever a Claude run does to
 * the copy cannot reach the approved draft the Console shows. `null` (a
 * draft without doc_dir) is passed through without copying. */
export async function withReadOnlyDocDirCopy<T>(
  docDir: string | null,
  fn: (copy: string | null) => Promise<T>,
  deps: DocDirCopyDeps = defaultDocDirCopyDeps,
): Promise<T> {
  if (docDir === null || !(await deps.pathExists(docDir))) return fn(null);
  const tempDir = await deps.makeTempDir();
  try {
    const copy = join(tempDir, "requirements");
    await deps.copyDir(docDir, copy);
    return await fn(copy);
  } finally {
    await deps.removeDir(tempDir);
  }
}

// ---------------------------------------------------------------------------
// One Claude run (generate's round 1 and every fix round)
// ---------------------------------------------------------------------------

/** One Claude run's result as the verify loop consumes it. Never thrown:
 * a failed run is data too, recorded as an `error` round (design §2). */
export type ImplementClaudeRound =
  | {
      readonly kind: "output";
      readonly output: ImplementClaudeOutput;
      readonly agent_run_id: number;
      readonly cost_usd: number;
    }
  | {
      readonly kind: "invalid_output";
      readonly output: ImplementClaudeOutput;
      /** validateImplementOutput's operator-facing reason (never shown to Claude). */
      readonly reason: string;
      readonly agent_run_id: number;
      readonly cost_usd: number;
    }
  | {
      readonly kind: "claude_failed";
      readonly reason: string;
      readonly detail: string;
      readonly agent_run_id: number;
      readonly cost_usd: number;
    };

export const IMPLEMENT_CLAUDE_ROUND_KINDS: readonly ImplementClaudeRound["kind"][] =
  ["output", "invalid_output", "claude_failed"];

/** runClaude's result → ImplementClaudeRound. The semantic check runs only
 * after a successful run (design §13: folding it into isStructuredOutput
 * would re-run the whole implementation for a long subject). */
export function toImplementClaudeRound(
  result: RunClaudeResult<ImplementClaudeOutput>,
  agentRunId: number,
): ImplementClaudeRound {
  const costUsd = result.agentRun.cost_usd ?? 0;
  if (result.outcome === "failure") {
    return {
      kind: "claude_failed",
      reason: result.reason,
      detail: result.detail,
      agent_run_id: agentRunId,
      cost_usd: costUsd,
    };
  }
  const validation = validateImplementOutput(result.structuredOutput);
  if (!validation.ok) {
    return {
      kind: "invalid_output",
      output: result.structuredOutput,
      reason: validation.reason,
      agent_run_id: agentRunId,
      cost_usd: costUsd,
    };
  }
  return {
    kind: "output",
    output: result.structuredOutput,
    agent_run_id: agentRunId,
    cost_usd: costUsd,
  };
}

export const IMPLEMENT_CLAUDE_TOOLS: readonly string[] = [
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
];
export const IMPLEMENT_CLAUDE_ALLOWED_TOOLS: readonly string[] = [
  "Edit",
  "Write",
];

export type ImplementClaudeRunInput = {
  readonly run: CommandRunner;
  readonly config: Pick<
    FactoryConfig,
    | "model"
    | "implement_max_turns"
    | "implement_max_budget_usd_per_run"
    | "implement_timeout_sec"
  >;
  readonly workItemId: number;
  readonly attempt: number;
  readonly stage: "implement" | "implement_fix";
  readonly prompt: string;
  /** buildSystemPrompt([IMPLEMENT_SKILL_NAME])'s file. */
  readonly systemPromptPath: string;
  readonly worktreeDir: string;
  /** The per-run doc_dir copy (withReadOnlyDocDirCopy), or null. */
  readonly docDir: string | null;
  readonly oauthToken: string;
};

export type ImplementClaudeRunDeps = {
  readonly runClaude: (
    opts: RunClaudeOptions<ImplementClaudeOutput>,
  ) => Promise<RunClaudeResult<ImplementClaudeOutput>>;
  readonly recordAgentRun: (record: AgentRunRecord) => Promise<number>;
};

/** The implement flow's runClaude options (design §2 implement_generate):
 * no Bash, `dontAsk` + `--allowedTools Edit Write` (the combination pr_fix
 * measured to allow writes), cwd = worktree, the doc_dir copy via addDirs. */
export function buildImplementClaudeOptions(
  input: ImplementClaudeRunInput,
): RunClaudeOptions<ImplementClaudeOutput> {
  return {
    run: input.run,
    workItemId: input.workItemId,
    stage: input.stage,
    attempt: input.attempt,
    model: input.config.model,
    prompt: input.prompt,
    appendSystemPromptFile: input.systemPromptPath,
    jsonSchema: IMPLEMENT_SCHEMA,
    isStructuredOutput: isImplementClaudeOutput,
    tools: IMPLEMENT_CLAUDE_TOOLS,
    allowedTools: IMPLEMENT_CLAUDE_ALLOWED_TOOLS,
    permissionMode: "dontAsk",
    settingSources: ["user"],
    maxTurns: input.config.implement_max_turns,
    maxBudgetUsd: input.config.implement_max_budget_usd_per_run,
    cwd: input.worktreeDir,
    addDirs: input.docDir === null ? [] : [input.docDir],
    oauthToken: input.oauthToken,
    timeoutMs: input.config.implement_timeout_sec * 1000,
  };
}

/** Runs Claude once, records the agent run, and returns the round. */
export async function runImplementClaudeRound(
  deps: ImplementClaudeRunDeps,
  input: ImplementClaudeRunInput,
): Promise<ImplementClaudeRound> {
  const result = await deps.runClaude(buildImplementClaudeOptions(input));
  const agentRunId = await deps.recordAgentRun(result.agentRun);
  return toImplementClaudeRound(result, agentRunId);
}

// ---------------------------------------------------------------------------
// runImplementVerifyLoop (design §2 implement_verify, §0 "検証が OK になるまで")
// ---------------------------------------------------------------------------

/** How the verify loop ended. decideImplementRoundExit's exits (minus
 * `continue`) plus the loop's own stops before the checks. */
export type ImplementLoopExit =
  | "checks_passed"
  | "checks_skipped"
  | "requirements_gap"
  | "max_rounds"
  | "daily_budget"
  | "stalled"
  | "diff_too_large"
  | "symlink"
  | "git_pointer_modified"
  | "claude_error";

export const IMPLEMENT_LOOP_EXITS: readonly ImplementLoopExit[] = [
  "checks_passed",
  "checks_skipped",
  "requirements_gap",
  "max_rounds",
  "daily_budget",
  "stalled",
  "diff_too_large",
  "symlink",
  "git_pointer_modified",
  "claude_error",
];

export const GITLEAKS_TIMEOUT_MS = 5 * 60_000;

/** Names shown to Claude ("Check command failed: <name>") and in the PR
 * body's 動作確認結果 for the checks the flow itself owns. */
export const GITLEAKS_CHECK_NAME = "gitleaks (secret scan)";
export const NO_CHANGES_CHECK_NAME = "change check (factory)";
const NO_CHANGES_OUTPUT =
  "no changes produced: the worktree has no difference from the base branch, so nothing was implemented";
const OUTPUT_CONTRACT_LABEL = "output contract (factory)";

/** implementFixPrompt's outputContractNote for a round after an
 * invalid_output (design §13: list the semantic rules; the operator-facing
 * reason stays in the DB). Plain instructions, never fenced. */
export const IMPLEMENT_OUTPUT_CONTRACT_NOTE = [
  "Your previous structured output broke the output contract, so the flow could not use it.",
  '- outcome "done": gap_report is null; commit_subject is one non-empty line of at most 72 code points, not ending in "…", without control characters.',
  '- outcome "requirements_gap": gap_report is a non-empty string; commit_subject and commit_body are both "".',
  "Answer again with an output that follows these rules.",
].join("\n");

const FAILURE_TAIL_CHARS = 2000;

export type ChangeInspection = {
  /** Every path that differs from the context's base_sha. */
  readonly changes: readonly ChangedPath[];
  readonly packageJsonScriptsChanged: boolean;
  /** Blocking: any symlink creation / change / typechange (design §3). */
  readonly symlinkReasons: readonly string[];
};

export type LoopCheckResult = {
  readonly command: string;
  readonly ok: boolean;
  /** Full masked output (DB). */
  readonly output: string;
  /** Prompt-side excerpt. */
  readonly outputTail: string;
};

export type FixRoundRequest = {
  /** 1-based round number within this loop (the prompt's "Round n of m"). */
  readonly round: number;
  /** Fenced as DATA by implementFixPrompt. */
  readonly failures: readonly CheckFailure[];
  /** The previous output broke the contract: pass IMPLEMENT_OUTPUT_CONTRACT_NOTE as outputContractNote. */
  readonly contractViolated: boolean;
};

export type ImplementLoopDeps = {
  /** assertWorktreeGitPointer against the context's worktree_git_pointer;
   * throws WorktreeGitPointerModifiedError when a Claude run changed it. */
  readonly assertGitPointer: () => Promise<void>;
  /** Stages everything and fingerprints it (worktreeFingerprint, against base_sha). */
  readonly fingerprint: () => Promise<WorktreeFingerprint>;
  readonly inspectChanges: () => Promise<ChangeInspection>;
  /** evaluateDiffSizeGuard bound to the implement limits; blocking. */
  readonly diffSizeReasons: (
    changedFileCount: number,
    diffLineTotal: number,
  ) => readonly string[];
  readonly runGitleaks: () => Promise<GitleaksResult>;
  /** removeIgnoredFiles on the worktree; called right before every
   * runChecks (never when no check command runs). */
  readonly removeIgnoredFiles: () => Promise<void>;
  /** The repo's check commands (implementCheckCommandsFor); only called when there are some. */
  readonly runChecks: () => Promise<readonly LoopCheckResult[]>;
  readonly runFixRound: (
    request: FixRoundRequest,
  ) => Promise<ImplementClaudeRound>;
  readonly recordRound: (record: ImplementRoundRecord) => Promise<void>;
  readonly dailyBudgetExceeded: () => Promise<boolean>;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
};

export type ImplementLoopInput = {
  readonly workItemId: number;
  readonly attempt: number;
  /** factory_config.implement_max_rounds. */
  readonly maxRounds: number;
  readonly hasCheckCommands: boolean;
  /** implement_generate's result (round 1, mode implement). */
  readonly firstRound: ImplementClaudeRound;
};

export type ImplementLoopResult = {
  readonly exit: ImplementLoopExit;
  /** English, for status notes and describeReason; null on a success or gap exit. */
  readonly reason: string | null;
  readonly gap_report: string | null;
  /** Claude runs in this flow run. */
  readonly rounds: number;
  readonly total_cost_usd: number;
  /** The last output that passed validateImplementOutput. */
  readonly final_output: ImplementClaudeOutput | null;
  /** The final inspected round's classifyProtectedChanges lines. */
  readonly protected_changes: string[];
  /** The final round's checks; null when the loop stopped before them. */
  readonly checks: ImplementCheckSummary | null;
  readonly diff_stat: ImplementDiffStat | null;
  readonly changed_paths: string[];
  /** The staged tree of the round whose checks passed or were skipped (the
   * round the loop exited on); null for every other exit. implement_finish
   * commits only when the worktree still stages exactly this tree. */
  readonly verified_tree_sha: string | null;
};

type ProducedRound = Exclude<
  ImplementClaudeRound,
  { readonly kind: "claude_failed" }
>;

type CheckEvaluation = {
  readonly state: "passed" | "failed" | "skipped";
  readonly failures: CheckFailure[];
  readonly contractViolated: boolean;
  /** Failed outputs first, then passed ones (implement_rounds.check_output). */
  readonly outputText: string;
  /** Failure outputs + the contract reason (stall hash input). */
  readonly stallText: string;
  readonly skipReason: string | null;
  readonly summary: ImplementCheckSummary;
};

function section(name: string, output: string): string {
  return `$ ${name}\n${output}`;
}

async function evaluateChecks(
  deps: ImplementLoopDeps,
  round: ProducedRound,
  facts: {
    readonly noChanges: boolean;
    readonly protectedChanged: boolean;
    readonly hasCheckCommands: boolean;
  },
): Promise<CheckEvaluation> {
  const failures: CheckFailure[] = [];
  const failedOutputs: string[] = [];
  const passedOutputs: string[] = [];
  const stallParts: string[] = [];
  const results: { readonly command: string; readonly ok: boolean }[] = [];
  const contractViolated = round.kind === "invalid_output";
  if (round.kind === "invalid_output") {
    failedOutputs.push(section(OUTPUT_CONTRACT_LABEL, round.reason));
    stallParts.push(round.reason);
  }

  let skipReason: string | null = null;
  if (facts.noChanges) {
    failures.push({
      command: NO_CHANGES_CHECK_NAME,
      outputTail: NO_CHANGES_OUTPUT,
    });
    failedOutputs.push(section(NO_CHANGES_CHECK_NAME, NO_CHANGES_OUTPUT));
    stallParts.push(NO_CHANGES_OUTPUT);
  } else {
    const gitleaks = await deps.runGitleaks();
    results.push({ command: GITLEAKS_CHECK_NAME, ok: gitleaks.ok });
    if (!gitleaks.ok) {
      failures.push({
        command: GITLEAKS_CHECK_NAME,
        outputTail: gitleaks.output.slice(-FAILURE_TAIL_CHARS),
      });
      failedOutputs.push(section(GITLEAKS_CHECK_NAME, gitleaks.output));
      stallParts.push(gitleaks.output);
    }
    if (facts.protectedChanged) {
      skipReason = IMPLEMENT_CHECK_SKIP_REASONS.protected_paths;
    } else if (!facts.hasCheckCommands) {
      skipReason = IMPLEMENT_CHECK_SKIP_REASONS.no_commands;
    } else {
      await deps.removeIgnoredFiles();
      for (const result of await deps.runChecks()) {
        results.push({ command: result.command, ok: result.ok });
        if (result.ok) {
          passedOutputs.push(section(result.command, result.output));
        } else {
          failures.push({
            command: result.command,
            outputTail: result.outputTail,
          });
          failedOutputs.push(section(result.command, result.output));
          stallParts.push(result.output);
        }
      }
    }
  }

  const failed = failures.length > 0 || contractViolated;
  return {
    state: failed ? "failed" : skipReason !== null ? "skipped" : "passed",
    failures,
    contractViolated,
    outputText: [...failedOutputs, ...passedOutputs].join("\n\n"),
    stallText: stallParts.join("\n\n"),
    skipReason,
    summary:
      skipReason !== null
        ? { kind: "skipped", reason: skipReason }
        : { kind: "ran", results },
  };
}

function blockingStop(
  symlinkReasons: readonly string[],
  sizeReasons: readonly string[],
): {
  readonly exit: "symlink" | "diff_too_large";
  readonly reasons: readonly string[];
} | null {
  if (symlinkReasons.length > 0)
    return { exit: "symlink", reasons: symlinkReasons };
  if (sizeReasons.length > 0)
    return { exit: "diff_too_large", reasons: sizeReasons };
  return null;
}

function reasonForExit(exit: ImplementLoopExit, round: number): string | null {
  switch (exit) {
    case "max_rounds":
      return `implement checks still failing after ${String(round)} rounds`;
    case "daily_budget":
      return "daily budget exceeded";
    case "stalled":
      return `implement stalled after round ${String(round)}`;
    default:
      return null;
  }
}

/** The stop reason when the worktree's `.git` pointer changed; null when it
 * is intact. Any other error from the check propagates. Shared by the loop
 * and implement_finish (before preserveWork's scan and the final commit). */
export async function gitPointerStopReason(
  assertGitPointer: () => Promise<void>,
): Promise<string | null> {
  try {
    await assertGitPointer();
    return null;
  } catch (err) {
    if (err instanceof WorktreeGitPointerModifiedError) return err.message;
    throw err;
  }
}

/**
 * Checks one Claude round's worktree and either ends the loop or runs a fix
 * round, until the checks pass or skip, a guard fires, or Claude reports a
 * requirements gap. Per round, in this order: the worktree's `.git` pointer
 * check (a changed pointer stops the loop before any git command runs in
 * the worktree); record-and-stop for a failed run or a gap; fingerprint (stages everything, measures against
 * base_sha); change inspection; the blocking stops (symlink, then diff
 * size); a round with no difference from the base fails as "no changes"
 * without running any check; otherwise gitleaks, then the check commands
 * (skipped when a protected path changed or none are configured; ignored
 * files are removed right before them); the exit
 * decision (decideImplementRoundExit, with the staged tree sha as the diff
 * fingerprint); one implement_rounds row per Claude run.
 */
export async function runImplementVerifyLoop(
  deps: ImplementLoopDeps,
  input: ImplementLoopInput,
): Promise<ImplementLoopResult> {
  let round = 1;
  let current: ImplementClaudeRound = input.firstRound;
  let previousDiffHash: string | null = null;
  let previousCheckHash: string | null = null;
  let totalCostUsd = 0;
  let lastValidOutput: ImplementClaudeOutput | null = null;

  for (;;) {
    totalCostUsd += current.cost_usd;
    const mode: ImplementRoundMode = round === 1 ? "implement" : "fix";
    const base = {
      work_item_id: input.workItemId,
      attempt: input.attempt,
      mode,
      agent_run_id: current.agent_run_id,
    };
    const stopped = (
      fields: Partial<ImplementLoopResult> & Pick<ImplementLoopResult, "exit">,
    ): ImplementLoopResult => ({
      reason: null,
      gap_report: null,
      rounds: round,
      total_cost_usd: totalCostUsd,
      final_output: lastValidOutput,
      protected_changes: [],
      checks: null,
      diff_stat: null,
      changed_paths: [],
      verified_tree_sha: null,
      ...fields,
    });

    const pointerReason = await gitPointerStopReason(deps.assertGitPointer);
    if (pointerReason !== null) {
      await deps.recordRound({
        ...base,
        outcome: "check_failed",
        summary: current.kind === "claude_failed" ? "" : current.output.summary,
        gap_report: null,
        check_output: truncateCheckOutput(pointerReason),
        checks_skipped_reason: null,
        protected_changes: [],
        diff_stat: null,
      });
      return stopped({ exit: "git_pointer_modified", reason: pointerReason });
    }

    if (current.kind === "claude_failed") {
      const reason = `claude run failed (${current.reason}): ${current.detail}`;
      await deps.recordRound({
        ...base,
        outcome: "error",
        summary: "",
        gap_report: null,
        check_output: truncateCheckOutput(reason),
        checks_skipped_reason: null,
        protected_changes: [],
        diff_stat: null,
      });
      return stopped({ exit: "claude_error", reason });
    }
    const produced: ProducedRound = current;
    if (produced.kind === "output") {
      lastValidOutput = produced.output;
      if (produced.output.outcome === "requirements_gap") {
        await deps.recordRound({
          ...base,
          outcome: "requirements_gap",
          summary: produced.output.summary,
          gap_report: produced.output.gap_report,
          check_output: null,
          checks_skipped_reason: null,
          protected_changes: [],
          diff_stat: null,
        });
        return stopped({
          exit: "requirements_gap",
          gap_report: produced.output.gap_report,
        });
      }
    }

    const fingerprint = await deps.fingerprint();
    const inspection = await deps.inspectChanges();
    const protectedChanges = [
      ...classifyProtectedChanges(
        inspection.changes,
        inspection.packageJsonScriptsChanged,
      ),
    ];
    const changedPaths = inspection.changes.map((change) => change.path);
    const stop = blockingStop(
      inspection.symlinkReasons,
      deps.diffSizeReasons(
        inspection.changes.length,
        fingerprint.diffStat.added + fingerprint.diffStat.deleted,
      ),
    );
    if (stop !== null) {
      await deps.recordRound({
        ...base,
        outcome: "check_failed",
        summary: produced.output.summary,
        gap_report: null,
        check_output: truncateCheckOutput(stop.reasons.join("\n")),
        checks_skipped_reason: null,
        protected_changes: protectedChanges,
        diff_stat: fingerprint.diffStat,
      });
      return stopped({
        exit: stop.exit,
        reason: stop.reasons.join("; "),
        protected_changes: protectedChanges,
        diff_stat: fingerprint.diffStat,
        changed_paths: changedPaths,
      });
    }

    const evaluation = await evaluateChecks(deps, produced, {
      noChanges: fingerprint.diffStat.files === 0,
      protectedChanged: protectedChanges.length > 0,
      hasCheckCommands: input.hasCheckCommands,
    });
    const checkHash =
      evaluation.state === "failed" ? stallHash(evaluation.stallText) : null;
    const dailyBudgetExceeded =
      evaluation.state === "failed" ? await deps.dailyBudgetExceeded() : false;
    const exit = decideImplementRoundExit({
      claudeOutcome: "done",
      checks: evaluation.state,
      round,
      maxRounds: input.maxRounds,
      dailyBudgetExceeded,
      checkOutputHash: checkHash,
      previousCheckOutputHash: previousCheckHash,
      diffHash: fingerprint.treeSha,
      previousDiffHash,
    });
    await deps.recordRound({
      ...base,
      outcome: roundOutcomeForExit(exit),
      summary: produced.output.summary,
      gap_report: null,
      check_output:
        evaluation.outputText.length === 0
          ? null
          : truncateCheckOutput(evaluation.outputText),
      checks_skipped_reason: evaluation.skipReason,
      protected_changes: protectedChanges,
      diff_stat: fingerprint.diffStat,
    });
    if (exit !== "continue") {
      return stopped({
        exit,
        reason: reasonForExit(exit, round),
        protected_changes: protectedChanges,
        checks: evaluation.summary,
        diff_stat: fingerprint.diffStat,
        changed_paths: changedPaths,
        verified_tree_sha:
          exit === "checks_passed" || exit === "checks_skipped"
            ? fingerprint.treeSha
            : null,
      });
    }

    deps.log("implement round failed its checks; starting a fix round", {
      round,
      failed: evaluation.failures.map((failure) => failure.command),
      contract_violated: evaluation.contractViolated,
    });
    previousDiffHash = fingerprint.treeSha;
    previousCheckHash = checkHash;
    round += 1;
    current = await deps.runFixRound({
      round,
      failures: evaluation.failures,
      contractViolated: evaluation.contractViolated,
    });
  }
}
