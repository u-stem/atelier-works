// Pure decision/parsing logic for cleanup_workspaces.ts (plan §4
// "cleanup_workspaces", §4b). No I/O — see that script for wiring (git
// worktree operations, `ps`/process signals, `du`).

import type { WorktreeEntry } from "./workspace.ts";

// ---------------------------------------------------------------------------
// Worktree path naming
// ---------------------------------------------------------------------------

/** The fetch-only main clone dir for a target repo (matches `ensureRepo`'s
 * own `<baseDir>/<owner>/<repo>/main` formula, default `baseDir`
 * "/workspaces" — duplicated here as a plain string formula rather than a
 * call into `ensureRepo` itself, since cleanup_workspaces.ts only needs the
 * deterministic path, never the clone/fetch side effect). */
export function mainRepoDir(owner: string, repo: string): string {
  return `/workspaces/${owner}/${repo}/main`;
}

/** The read-only detached worktree path for an issue-kind work item's
 * requirements-generation stage — mirrors
 * f/factory/steps/pipeline_prepare.ts's own `buildRequirementsWorktreeDir`
 * (duplicated rather than imported: a top-level script importing from
 * steps/ would blur the "steps are wired by their own flow" boundary the
 * windmill-script skill draws; see poll_support.ts's own header comment for
 * the project's precedent on this kind of small, intentional duplication). */
export function requirementsWorktreeDir(
  owner: string,
  repo: string,
  issueNumber: number,
): string {
  return `/workspaces/${owner}/${repo}/req-${issueNumber}`;
}

// ---------------------------------------------------------------------------
// issueWorktreePaths: which worktrees an issue-kind work item leaves behind
// ---------------------------------------------------------------------------

/** The two `work_items` columns an issue-kind item's worktrees are keyed
 * by — structural so a full `WorkItem` (lib/types.ts) can be passed as-is. */
export type IssueWorktreeSource = {
  readonly issue_number: number | null;
  readonly branch: string | null;
};

/**
 * Every worktree path cleanup_workspaces.ts should remove for one
 * issue-kind work item: the detached `req-<N>` requirements worktree
 * (工程2, `requirementsWorktreeDir`) when it is listed, plus the worktree
 * checked out on `item.branch` (工程3's implement branch,
 * `work_items.branch`) when the item has one. `worktrees` is the parsed
 * `git worktree list --porcelain` output for the repo. The fetch-only
 * main clone (`mainRepoDir`) is never returned, even if it happens to sit
 * on that branch. Pure — no I/O.
 */
export function issueWorktreePaths(
  owner: string,
  repo: string,
  item: IssueWorktreeSource,
  worktrees: readonly WorktreeEntry[],
): string[] {
  const main = mainRepoDir(owner, repo);
  const paths: string[] = [];
  if (item.issue_number !== null) {
    const reqDir = requirementsWorktreeDir(owner, repo, item.issue_number);
    if (worktrees.some((entry) => entry.path === reqDir)) {
      paths.push(reqDir);
    }
  }
  if (item.branch !== null) {
    for (const entry of worktrees) {
      if (
        entry.branch === item.branch &&
        entry.path !== main &&
        !paths.includes(entry.path)
      ) {
        paths.push(entry.path);
      }
    }
  }
  return paths;
}

// ---------------------------------------------------------------------------
// groupByRepo: batch a stale-item list by (owner, repo)
// ---------------------------------------------------------------------------

export type RepoGroup<T> = {
  readonly owner: string;
  readonly repo: string;
  readonly items: T[];
};

/** Groups `items` by `(owner, repo)`, preserving first-seen order of both
 * the groups and the items within each group — lets cleanup_workspaces.ts
 * call `listWorktrees`/`pruneWorktrees` once per repo instead of once per
 * stale work item. */
export function groupByRepo<
  T extends { readonly owner: string; readonly repo: string },
>(items: readonly T[]): RepoGroup<T>[] {
  const order: string[] = [];
  const groups = new Map<string, RepoGroup<T>>();
  for (const item of items) {
    const key = `${item.owner}/${item.repo}`;
    const existing = groups.get(key);
    if (existing !== undefined) {
      existing.items.push(item);
      continue;
    }
    groups.set(key, { owner: item.owner, repo: item.repo, items: [item] });
    order.push(key);
  }
  return order.map((key) => {
    const group = groups.get(key);
    if (group === undefined) {
      throw new Error(`groupByRepo: missing group for key ${key}`);
    }
    return group;
  });
}

// ---------------------------------------------------------------------------
// selectOrphanClaudePids: parse `ps -eo pid,etimes,args`
// ---------------------------------------------------------------------------

type PsEntry = {
  readonly pid: number;
  readonly etimes: number;
  readonly args: string;
};

/** Parses one `ps -eo pid,etimes,args` data line (`<pid> <etimes>
 * <args...>`, whitespace-separated, `args` free-form). `null` for a line
 * that doesn't start with two numeric fields — in particular the header
 * line (`PID ELAPSED COMMAND` or similar), which is silently dropped this
 * way rather than special-cased. */
function parsePsLine(line: string): PsEntry | null {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
  if (match === null) return null;
  const pidText = match[1];
  const etimesText = match[2];
  const args = match[3];
  if (pidText === undefined || etimesText === undefined || args === undefined) {
    return null;
  }
  const pid = Number(pidText);
  const etimes = Number(etimesText);
  if (!Number.isFinite(pid) || !Number.isFinite(etimes)) return null;
  return { pid, etimes, args };
}

/** Whether `args` (the full command line `ps` reports for one process)
 * looks like a headless Claude invocation (`claude ... -p ...`), regardless
 * of the binary's path prefix (`/usr/local/bin/claude`) or flag ordering. */
function isClaudeHeadlessInvocation(args: string): boolean {
  const tokens = args.split(/\s+/).filter((token) => token.length > 0);
  const command = tokens[0];
  if (command === undefined) return false;
  const looksLikeClaude = command === "claude" || command.endsWith("/claude");
  return looksLikeClaude && tokens.slice(1).includes("-p");
}

/**
 * Parses `ps -eo pid,etimes,args` output and returns the pids of every
 * headless Claude (`claude -p`) process whose elapsed time (`etimes`,
 * seconds) exceeds `timeoutSec`. A headless Claude process still running
 * past its own `claude_timeout_sec` subprocess timeout (lib/claude.ts's own
 * `runClaude` enforces that timeout on the process it directly spawned)
 * can only mean that enforcement never got the chance to fire — e.g. its
 * parent Windmill job was killed/cancelled first, reparenting the child
 * before it could be signaled — so any such process found here is by
 * definition orphaned and safe to terminate.
 */
export function selectOrphanClaudePids(
  psOutput: string,
  timeoutSec: number,
): number[] {
  return psOutput
    .split("\n")
    .map(parsePsLine)
    .filter((entry): entry is PsEntry => entry !== null)
    .filter(
      (entry) =>
        entry.etimes > timeoutSec && isClaudeHeadlessInvocation(entry.args),
    )
    .map((entry) => entry.pid);
}

// ---------------------------------------------------------------------------
// terminateOrphans: SIGTERM -> wait -> SIGKILL escalation (injectable)
// ---------------------------------------------------------------------------

export type TerminateOrphansDeps = {
  /** Sends `signal` to `pid`. Defaults to `process.kill`. Never needs to
   * itself guard against an already-exited pid — `terminateOrphans` wraps
   * every call in a try/catch (a process that already exited between the
   * `ps` snapshot and this call is not an error). */
  readonly kill?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  /** Whether `pid` is still alive. Defaults to a `process.kill(pid, 0)`
   * existence check. */
  readonly isAlive?: (pid: number) => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_KILL_GRACE_MS = 10_000;

function defaultKill(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  process.kill(pid, signal);
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function safeKill(
  kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => void,
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
): void {
  try {
    kill(pid, signal);
  } catch {
    // Already exited between the `ps` snapshot and this call — not an error.
  }
}

export type TerminateOrphansResult = {
  /** Every pid this call sent SIGTERM to. */
  readonly terminated: number[];
  /** The subset still alive after the grace period, sent SIGKILL. */
  readonly killed: number[];
};

/**
 * SIGTERM every pid in `pids`, wait `graceMs` (default 10s), then SIGKILL
 * whichever ones are still alive. `deps` is fully optional/injectable so
 * this stays testable without a real 10-second wait or real OS signals.
 */
export async function terminateOrphans(
  pids: readonly number[],
  deps: TerminateOrphansDeps = {},
  graceMs: number = DEFAULT_KILL_GRACE_MS,
): Promise<TerminateOrphansResult> {
  const kill = deps.kill ?? defaultKill;
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const sleep = deps.sleep ?? defaultSleep;

  for (const pid of pids) {
    safeKill(kill, pid, "SIGTERM");
  }
  await sleep(graceMs);
  const stillAlive = pids.filter((pid) => isAlive(pid));
  for (const pid of stillAlive) {
    safeKill(kill, pid, "SIGKILL");
  }
  return { terminated: [...pids], killed: stillAlive };
}

// ---------------------------------------------------------------------------
// Disk usage (`du -sk /workspaces`)
// ---------------------------------------------------------------------------

/** Parses the leading byte-block count (in KiB, per `du`'s `-k` flag) from
 * `du -sk`'s `<size>\t<path>` output. */
export function parseDiskUsageKb(duOutput: string): number {
  const match = duOutput.trim().match(/^(\d+)/);
  const sizeText = match?.[1];
  if (sizeText === undefined) {
    throw new Error(
      `cleanup_workspaces: unexpected 'du -sk' output: ${JSON.stringify(duOutput)}`,
    );
  }
  return Number(sizeText);
}

/** Formats a human-readable (Japanese) disk usage notice message for
 * `factory.notices`, in MiB for readability. */
export function formatDiskUsageMessage(usageKb: number, path: string): string {
  const usageMib = (usageKb / 1024).toFixed(1);
  return `${path} のディスク使用量は約 ${usageMib} MiB です。`;
}
