// The implement flow's (工程3 design §2) shared contract and verify loop:
// the ImplementContext implement_prepare hands to every later step, the
// branch/worktree preparation order, the per-run doc_dir copy, one Claude
// run turned into an ImplementClaudeRound (generate and every fix round),
// and runImplementVerifyLoop with every I/O injected so it is unit-testable
// and reusable by pr_fix later. lib never imports steps: the verify step
// binds the steps-side helpers (diff-size guard, change listing, symlink
// detection) into ImplementLoopDeps.

import { access, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunClaudeOptions, RunClaudeResult } from "./claude.ts";
import {
  type ImplementClaudeOutput,
  isImplementClaudeOutput,
  validateImplementOutput,
} from "./implement_support.ts";
import { IMPLEMENT_SCHEMA, type ImplementPromptInput } from "./prompts.ts";
import type { AgentRunRecord, Diagram, FactoryConfig } from "./types.ts";
import type { CommandRunner } from "./workspace.ts";

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

export const defaultDocDirCopyDeps: DocDirCopyDeps = {
  pathExists: (path) =>
    access(path).then(
      () => true,
      () => false,
    ),
  makeTempDir: () => mkdtemp(join(tmpdir(), "factory-requirements-")),
  copyDir: (source, destination) =>
    cp(source, destination, { recursive: true }),
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
