// Clone / fetch / worktree management for target repositories and the
// factory's own self clone (spec-cycle2.md §1 workspace.ts, §7 items 2 and
// 9). All subprocess execution goes through the injected `run`
// (`CommandRunner`) — nothing here spawns `Bun.spawn` directly except the
// default `runCommand` implementation, so every function is testable with a
// fake runner.
//
// `CommandRunner` / `CommandResult` are defined here (not in types.ts,
// which predates this module) and re-exported for use by github.ts and
// claude.ts, which shell out the same way.
//
// Security hardening (post-M4 security-audit fixes):
// - Every git invocation goes through `buildGitArgv`, which resets
//   `credential.helper` (`-c credential.helper=`, clearing any
//   system/global helper list) and disables hooks/fsmonitor
//   (`-c core.hooksPath=/dev/null -c core.fsmonitor=false`) so a
//   compromised/malicious clone can't run arbitrary hook scripts or an
//   fsmonitor helper. Only network operations (clone/fetch/push) add back
//   `-c credential.helper='!gh auth git-credential'` and get `GH_TOKEN` in
//   their env (`networkGitEnv`); local-only operations (rev-parse, status,
//   add, commit, worktree, diff) use `localGitEnv`, which never carries the
//   token.
// - User-derived positional arguments (URLs, dirs, shas, branches) are
//   preceded by `--` to stop a value starting with `-` from being
//   misread as a flag — EXCEPT for `git rev-parse`, which is a documented,
//   verified exception: `git rev-parse -- <rev>` doesn't work like other
//   subcommands (it degrades `--verify` to "no revision given", and in
//   non-`--verify` mode it *echoes* a literal `--` line before the
//   requested output instead of suppressing option parsing). Verified
//   empirically; rev-parse calls below rely on `assertSha`/`assertBranchName`
//   input validation instead for the same "no leading `-`" protection.
//   `git gtr new` (a third-party subcommand, not core git) also skips `--`
//   since its own argv handling isn't guaranteed `--`-compatible; branch
//   names are validated via `assertBranchName` before reaching it either way.
//   `readGitShowFile`'s `git show <ref>:<path>` is a third exception, for a
//   different reason: `--` doesn't error there either, it silently changes
//   what git returns (see that function's doc comment for the verified
//   behavior) — `ref` is validated via `assertBranchName` instead, which
//   also protects `path` transitively (it always follows a validated,
//   `:`-free `ref` and our own inserted `:` in the same argv entry).
//   `createGtrWorktree`'s reuse-path `git reset --hard <ref>` is a fourth
//   exception: `--` before the ref there errors outright ("fatal: Cannot
//   do hard reset with paths" — verified empirically), since `--hard`
//   mode doesn't take a pathspec at all; `assertBranchName` validation
//   again stands in for it.
// - Callers pass GitHub-sourced identifiers (owner, repo, sha, branch)
//   through `assertGitHubName` / `assertSha` / `assertBranchName`
//   (types.ts) before they're interpolated into a URL, ref, or directory
//   path.
// - `commitAndPush` verifies the worktree it's about to run git in is a
//   *registered* worktree of the expected repo, and that its `.git` file's
//   `gitdir:` target actually lives under that repo's
//   `.git/worktrees/<name>/` — guards against operating on a
//   worktree directory that was redirected (e.g. a replaced `.git` file)
//   to point somewhere else.
//
// Locking note: `withRepoLock` is a userspace lockfile mutex (atomic
// exclusive file creation + mtime-based staleness + a per-acquisition
// token that gates release, so a reclaimed lock is never deleted out from
// under its new owner), not a literal flock(2) syscall — see the
// implementer's report for why (Bun/Node have no core flock binding, and
// wrapping an in-process async callback around the `flock(1)` CLI is
// fragile). This is enough to serialize concurrent `ensureRepo` calls for
// the same repo within one worker container.

import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { maskSecrets } from "./log.ts";
import {
  assertBranchName,
  assertGitHubName,
  assertSha,
  type GitIdentity,
  type ImplementDiffStat,
  isNumber,
  isRecord,
  isString,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Subprocess execution (shared with github.ts / claude.ts)
// ---------------------------------------------------------------------------

export type CommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
};

export type CommandRunOptions = {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly timeoutMs?: number;
  /** Per-stream ceiling on the bytes kept from stdout and from stderr
   * (工程3 design §14: untrusted command output must not rely on post-hoc
   * truncation alone). The stream is still drained to the end, so the child
   * never blocks on a full pipe, but only the first and the last half of
   * this many bytes are kept, joined by `omittedMarker`. Omitted: keep
   * everything (the previous behaviour). */
  readonly maxOutputBytes?: number;
};

export type CommandRunner = (
  argv: readonly string[],
  options?: CommandRunOptions,
) => Promise<CommandResult>;

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_KILL_GRACE_MS = 5_000;

export type BunCommandRunnerOptions = {
  /** Grace period between SIGTERM and SIGKILL when a command times out. Default 5000ms. */
  readonly killGraceMs?: number;
};

/**
 * Build a `CommandRunner` that spawns via `Bun.spawn`. On timeout, sends
 * SIGTERM first and escalates to SIGKILL after `killGraceMs` (default 5s)
 * if the process hasn't exited by then.
 */
// Signaling only the directly-spawned pid is not enough to guarantee a
// timed-out command actually stops: if it forked a child of its own (e.g. a
// shell running a pipeline, or a credential helper), that grandchild is not
// signaled and can keep the stdout/stderr pipes open — `Promise.all` below
// then hangs reading those pipes until the grandchild exits on its own,
// silently defeating the timeout. Verified empirically (`sh -c "trap ''
// TERM; sleep 5"` killed only by pid: the pipe read didn't resolve until
// the full 5s naturally elapsed). Fix: spawn `detached: true` (POSIX
// `setsid()`, making the child its own process-group leader) and signal the
// whole group via `process.kill(-pid, signal)`.
function killProcessGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already exited — nothing to signal.
  }
}

const OMITTED_MARKER_PATTERN = /\[\.\.\. \d+ bytes omitted \.\.\.\]/;

/** The text readStreamCapped puts between the kept head and tail. */
export function omittedMarker(bytes: number): string {
  return `\n[... ${String(bytes)} bytes omitted ...]\n`;
}

/** Whether readStreamCapped dropped bytes from `text` (a machine-readable
 * report cut this way must not be parsed). */
export function isCappedOutput(text: string): boolean {
  return OMITTED_MARKER_PATTERN.test(text);
}

/** Reads `stream` to the end, keeping the first `floor(maxBytes / 2)` bytes
 * in a fixed head buffer and the last `maxBytes - floor(maxBytes / 2)`
 * bytes in a fixed ring buffer (chunks are copied in; nothing grows with
 * the stream). When bytes in between were dropped, the two parts are
 * decoded separately and joined by `omittedMarker(droppedBytes)` (a
 * multi-byte character cut at either edge decodes to U+FFFD). */
export async function readStreamCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string> {
  const headLimit = Math.floor(maxBytes / 2);
  const tailLimit = maxBytes - headLimit;
  const head = new Uint8Array(headLimit);
  let headSize = 0;
  const ring = new Uint8Array(tailLimit);
  let ringStart = 0;
  let ringSize = 0;
  let omitted = 0;

  const pushTail = (bytes: Uint8Array): void => {
    if (tailLimit === 0) {
      omitted += bytes.byteLength;
      return;
    }
    if (bytes.byteLength >= tailLimit) {
      omitted += ringSize + (bytes.byteLength - tailLimit);
      ring.set(bytes.subarray(bytes.byteLength - tailLimit), 0);
      ringStart = 0;
      ringSize = tailLimit;
      return;
    }
    const overflow = ringSize + bytes.byteLength - tailLimit;
    if (overflow > 0) {
      ringStart = (ringStart + overflow) % tailLimit;
      ringSize -= overflow;
      omitted += overflow;
    }
    const writeAt = (ringStart + ringSize) % tailLimit;
    const firstPart = Math.min(bytes.byteLength, tailLimit - writeAt);
    ring.set(bytes.subarray(0, firstPart), writeAt);
    ring.set(bytes.subarray(firstPart), 0);
    ringSize += bytes.byteLength;
  };

  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let offset = 0;
    if (headSize < headLimit) {
      const take = Math.min(headLimit - headSize, value.byteLength);
      head.set(value.subarray(0, take), headSize);
      headSize += take;
      offset = take;
    }
    if (offset < value.byteLength) pushTail(value.subarray(offset));
  }

  const tail = new Uint8Array(ringSize);
  const firstPart = Math.min(ringSize, tailLimit - ringStart);
  tail.set(ring.subarray(ringStart, ringStart + firstPart), 0);
  tail.set(ring.subarray(0, ringSize - firstPart), firstPart);
  const decoder = new TextDecoder();
  if (omitted === 0) {
    const whole = new Uint8Array(headSize + ringSize);
    whole.set(head.subarray(0, headSize), 0);
    whole.set(tail, headSize);
    return decoder.decode(whole);
  }
  return `${decoder.decode(head.subarray(0, headSize))}${omittedMarker(omitted)}${decoder.decode(tail)}`;
}

export function createBunCommandRunner(
  options: BunCommandRunnerOptions = {},
): CommandRunner {
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  return async (argv, runOptions = {}) => {
    const proc = Bun.spawn({
      cmd: [...argv],
      ...(runOptions.cwd !== undefined ? { cwd: runOptions.cwd } : {}),
      env: runOptions.env !== undefined ? { ...runOptions.env } : {},
      stdin: runOptions.stdin !== undefined ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });

    if (
      runOptions.stdin !== undefined &&
      proc.stdin !== undefined &&
      typeof proc.stdin !== "number"
    ) {
      proc.stdin.write(runOptions.stdin);
      proc.stdin.end();
    }

    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(proc.pid, "SIGTERM");
      killTimer = setTimeout(() => {
        killProcessGroup(proc.pid, "SIGKILL");
      }, killGraceMs);
    }, runOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const readOutput = (stream: ReadableStream<Uint8Array>): Promise<string> =>
      runOptions.maxOutputBytes === undefined
        ? new Response(stream).text()
        : readStreamCapped(stream, runOptions.maxOutputBytes);
    const [stdout, stderr, exitCode] = await Promise.all([
      readOutput(proc.stdout),
      readOutput(proc.stderr),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (killTimer !== undefined) clearTimeout(killTimer);

    return { stdout, stderr, exitCode, timedOut };
  };
}

/** Default `CommandRunner`: `createBunCommandRunner()` with default settings. */
export const runCommand: CommandRunner = createBunCommandRunner();

// ---------------------------------------------------------------------------
// git argv / env construction
// ---------------------------------------------------------------------------

export type GitCommandOptions = {
  /** Whether this invocation talks to a remote (clone/fetch/push) — adds the gh credential helper and requires `GH_TOKEN` in env. */
  readonly network?: boolean;
};

/**
 * Prefix `args` with the common hardening flags: reset `credential.helper`
 * (clearing any system/global helper), disable hooks and fsmonitor, and —
 * for network operations only — add back the gh credential helper.
 */
function buildGitArgv(
  args: readonly string[],
  options: GitCommandOptions = {},
): string[] {
  return [
    "git",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "credential.helper=",
    ...(options.network === true
      ? ["-c", "credential.helper=!gh auth git-credential"]
      : []),
    ...args,
  ];
}

/** Env for git operations that never touch the network — no `GH_TOKEN`. */
function localGitEnv(home?: string, path?: string): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  const resolvedHome = home ?? process.env.HOME;
  if (resolvedHome !== undefined) env.HOME = resolvedHome;
  const resolvedPath = path ?? process.env.PATH;
  if (resolvedPath !== undefined) env.PATH = resolvedPath;
  return env;
}

/** Env for git operations that clone/fetch/push — carries `GH_TOKEN` for the gh credential helper. */
function networkGitEnv(
  ghToken: string,
  home?: string,
  path?: string,
): Record<string, string> {
  return { ...localGitEnv(home, path), GH_TOKEN: ghToken };
}

/**
 * Convert `overrides` into `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<i>` /
 * `GIT_CONFIG_VALUE_<i>` env vars — git reads these the same as `-c
 * key=value` regardless of which git subcommand (or wrapper around git)
 * invoked it, which matters for `git gtr` (security fix, medium): it's a
 * third-party subcommand whose own argv parsing can't be trusted to accept
 * an interspersed `-c` flag the way a direct `git` invocation can (see the
 * "No `--` here" note on `createGtrWorktree`'s `gtr new` call for the same
 * reasoning applied to `--`), so config overrides for it go through env
 * instead. Merge the result into `networkGitEnv(...)`/`localGitEnv(...)`.
 */
function gitConfigEnvOverrides(
  overrides: Readonly<Record<string, string>>,
): Record<string, string> {
  const entries = Object.entries(overrides);
  const env: Record<string, string> = {
    GIT_CONFIG_COUNT: String(entries.length),
  };
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

/** Build a masked `Error` from a failed `CommandResult`, for a consistent `throw` shape across this module. */
function gitError(context: string, result: CommandResult): Error {
  return new Error(maskSecrets(`${context}: ${result.stderr.trim()}`));
}

/**
 * `git config core.symlinks false`, persisted into `dir`'s config — a
 * re-gate fix (High, adopted): `-c core.symlinks=false` on
 * `addDetachedWorktree`'s `worktree add` (and the `GIT_CONFIG_*` env on
 * `git gtr new`) only applies to that ONE invocation; every later
 * operation on the same repo (`git status`, `add -A`, `commit`, and
 * critically `createGtrWorktree`'s reuse-path `reset --hard`) runs with
 * git's default `core.symlinks=true` unless the setting is persisted —
 * letting `reset --hard` recreate a real symlink from a committed one,
 * which then shows up as a `typechange` in the next commit. Persisting it
 * into the *main* clone's config covers every worktree of this repo, since
 * they all share it (git worktrees read the main clone's `.git/config`).
 * `ensureRepo` calls this after every successful clone/fetch; the
 * per-invocation `-c`/`GIT_CONFIG_*` settings elsewhere are kept too —
 * redundant with this now, but harmless.
 */
async function persistNoSymlinksConfig(
  run: CommandRunner,
  dir: string,
  home?: string,
  path?: string,
): Promise<void> {
  const result = await run(buildGitArgv(["config", "core.symlinks", "false"]), {
    cwd: dir,
    env: localGitEnv(home, path),
  });
  if (result.exitCode !== 0) {
    throw gitError("git config core.symlinks false failed", result);
  }
}

/**
 * The lock path scoping ALL git activity for one repo's directory tree
 * (`ensureRepo`'s main clone plus every worktree under the same parent
 * dir) — `repoDir` is always `<owner-repo-dir>/main`, so its parent is the
 * same `<baseDir>/<owner>/<repo>` directory `ensureRepo` locks. Shared by
 * `addDetachedWorktree` / `createGtrWorktree` / `removeWorktree` /
 * `commitAndPush` (code-review fix: avoid `.git/index.lock` races between
 * concurrent flows touching the same repo).
 */
function repoLockPath(repoDir: string): string {
  return `${dirname(repoDir)}/main.lock`;
}

// ---------------------------------------------------------------------------
// Filesystem existence check (injectable for tests)
// ---------------------------------------------------------------------------

export type PathExists = (path: string) => Promise<boolean>;

export const pathExists: PathExists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Plain filesystem helpers (requirements-doc directory management —
// pipeline_generate.ts writes/reads a docDir per attempt, cleanup_db.ts
// deletes old ones). Injectable, same rationale as `pathExists` above:
// every caller takes these as parameters (defaulting to the real
// implementation here) so tests never touch the real filesystem.
// ---------------------------------------------------------------------------

export type ReadDir = (path: string) => Promise<string[]>;

/** Lists a directory's entry names (files and subdirectories alike, not
 * recursive) — used by pipeline_generate.ts to find the `.drawio` files
 * Claude wrote alongside `requirements.md`. */
export const readDirEntries: ReadDir = (path) => readdir(path);

export type ReadTextFile = (path: string) => Promise<string>;

export const readTextFile: ReadTextFile = (path) => readFile(path, "utf8");

export type WriteTextFile = (path: string, content: string) => Promise<void>;

export const writeTextFile: WriteTextFile = (path, content) =>
  writeFile(path, content);

export type CopyFile = (source: string, destination: string) => Promise<void>;

export const copyFileTo: CopyFile = (source, destination) =>
  copyFile(source, destination);

export type RemovePath = (path: string) => Promise<void>;

/** Recursively removes `path` (file or directory); a no-op if it doesn't
 * exist. */
export const removePath: RemovePath = (path) =>
  rm(path, { recursive: true, force: true });

export type MakeDir = (path: string) => Promise<void>;

export const makeDir: MakeDir = async (path) => {
  await mkdir(path, { recursive: true });
};

export type EnsureEmptyDirOptions = {
  readonly exists?: PathExists;
  readonly remove?: RemovePath;
  readonly mkdir?: MakeDir;
};

/**
 * Ensures `dir` exists and is empty: removes it first (recursively) if it
 * already exists, then recreates it. Used by pipeline_generate.ts at the
 * start of every requirements-generation attempt, so a retried attempt
 * never sees a previous attempt's stray `requirements.md` edits or leftover
 * `.drawio` files.
 */
export async function ensureEmptyDir(
  dir: string,
  opts: EnsureEmptyDirOptions = {},
): Promise<void> {
  const exists = opts.exists ?? pathExists;
  const remove = opts.remove ?? removePath;
  const mkdirFn = opts.mkdir ?? makeDir;
  if (await exists(dir)) {
    await remove(dir);
  }
  await mkdirFn(dir);
}

export type RemoveEmptyDir = (path: string) => Promise<boolean>;

/**
 * Removes `path` only if it is an empty directory — returns `true` when it
 * removed it, `false` when the directory was non-empty or didn't exist
 * (both treated as "nothing to do", never thrown). Used by cleanup_db.ts to
 * best-effort prune a now-empty `issue-<N>` requirements directory after
 * deleting its last `wi-<id>` subdirectory, without disturbing it if a
 * sibling work item's own `wi-<id>` directory is still there.
 */
export const removeEmptyDir: RemoveEmptyDir = async (path) => {
  try {
    await rmdir(path);
    return true;
  } catch (err) {
    if (
      isErrnoLike(err) &&
      (err.code === "ENOTEMPTY" || err.code === "ENOENT")
    ) {
      return false;
    }
    throw err;
  }
};

// ---------------------------------------------------------------------------
// withRepoLock: userspace lockfile mutex
// ---------------------------------------------------------------------------

export type LockFs = {
  /** Atomically create `lockPath` with `content`; false if it already exists. */
  readonly tryCreate: (lockPath: string, content: string) => Promise<boolean>;
  readonly read: (lockPath: string) => Promise<string | null>;
  /** File mtime in ms since epoch, or null if the lock doesn't exist. */
  readonly mtimeMs: (lockPath: string) => Promise<number | null>;
  /** Remove the lock (rename-then-unlink internally); no-op if already gone. */
  readonly remove: (lockPath: string) => Promise<void>;
  /**
   * Ensure `lockPath`'s parent directory exists (`mkdir -p` equivalent),
   * called once before the first `tryCreate` attempt. Real bug (E2E,
   * post-launch fix): `ensureFactoryClone`'s lock path's parent (e.g.
   * `/workspaces/factory/`) doesn't exist yet on a container's first-ever
   * run, before the clone that would create it — `tryCreate`'s
   * `open(path, "wx")` then fails with `ENOENT`, which it isn't built to
   * treat as "not locked" (only `EEXIST` means that). Optional: a fake
   * `LockFs` backed by an in-memory `Map` (as most tests use) has no real
   * directory hierarchy to create, so it can omit this and `withRepoLock`
   * just skips the call.
   */
  readonly ensureLockDir?: (lockPath: string) => Promise<void>;
};

type ErrnoLike = Error & { readonly code?: string };

function isErrnoLike(err: unknown): err is ErrnoLike {
  if (!(err instanceof Error)) return false;
  const maybeCode = (err as { code?: unknown }).code;
  return maybeCode === undefined || typeof maybeCode === "string";
}

export const defaultLockFs: LockFs = {
  ensureLockDir: async (lockPath) => {
    await mkdir(dirname(lockPath), { recursive: true });
  },
  tryCreate: async (lockPath, content) => {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(content);
      } finally {
        await handle.close();
      }
      return true;
    } catch (err) {
      if (isErrnoLike(err) && err.code === "EEXIST") {
        return false;
      }
      throw err;
    }
  },
  read: async (lockPath) => {
    try {
      return await readFile(lockPath, "utf8");
    } catch {
      return null;
    }
  },
  mtimeMs: async (lockPath) => {
    try {
      const info = await stat(lockPath);
      return info.mtimeMs;
    } catch {
      return null;
    }
  },
  remove: async (lockPath) => {
    // Rename-then-unlink: if the lock was already replaced/removed by
    // someone else, the rename itself fails (ENOENT) instead of us
    // unlinking whatever now occupies `lockPath`.
    const tempPath = `${lockPath}.removing-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      await rename(lockPath, tempPath);
    } catch (err) {
      if (isErrnoLike(err) && err.code === "ENOENT") return;
      throw err;
    }
    await unlink(tempPath);
  },
};

type LockFileContent = { readonly token: string };

// The predicate's target type is a named alias (not an inline `{...}`
// literal) so `scripts/lint-no-type-assertions.ts`'s brace-depth heuristic
// correctly recognizes this whole body as a type-guard region — an inline
// object-literal return type confuses it into closing the guard region at
// the literal's own `}` instead of the function body's.
function isLockFileContent(value: unknown): value is LockFileContent {
  if (typeof value !== "object" || value === null) return false;
  if (!("token" in value)) return false;
  return typeof (value as { token: unknown }).token === "string";
}

function parseLockToken(content: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isLockFileContent(parsed)) return null;
  return parsed.token;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export type WithRepoLockOptions<T> = {
  readonly lockPath: string;
  readonly fn: () => Promise<T>;
  readonly lockFs?: LockFs;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  /** A lock file whose mtime is older than this is treated as abandoned by a crashed holder. Default 10 minutes. */
  readonly staleMs?: number;
  readonly pollMs?: number;
  readonly maxWaitMs?: number;
};

/**
 * Run `fn` while holding an exclusive lock keyed by `lockPath`. Serializes
 * concurrent callers within one worker container (e.g. two flows both
 * calling `ensureRepo` for the same repo). See the module doc comment for
 * why this is a lockfile mutex rather than a `flock(2)` syscall, and for
 * the token/mtime staleness protocol.
 */
export async function withRepoLock<T>(
  opts: WithRepoLockOptions<T>,
): Promise<T> {
  const lockFs = opts.lockFs ?? defaultLockFs;
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? defaultSleep;
  const staleMs = opts.staleMs ?? 10 * 60_000;
  const pollMs = opts.pollMs ?? 200;
  // 5 minutes (code-review fix): now shared by every repo-tree git op
  // (ensureRepo, addDetachedWorktree, createGtrWorktree, removeWorktree,
  // commitAndPush), not just the initial clone/fetch, so it needs enough
  // headroom for a slow clone/checkout ahead of it in the queue.
  const maxWaitMs = opts.maxWaitMs ?? 5 * 60_000;
  const deadline = now().getTime() + maxWaitMs;
  const token = crypto.randomUUID();

  await lockFs.ensureLockDir?.(opts.lockPath);

  for (;;) {
    const created = await lockFs.tryCreate(
      opts.lockPath,
      JSON.stringify({ token }),
    );
    if (created) break;

    const mtimeMs = await lockFs.mtimeMs(opts.lockPath);
    if (mtimeMs !== null && now().getTime() - mtimeMs > staleMs) {
      await lockFs.remove(opts.lockPath);
      continue;
    }

    if (now().getTime() >= deadline) {
      throw new Error(
        `withRepoLock: timed out waiting for lock at ${opts.lockPath}`,
      );
    }
    await sleep(pollMs);
  }

  try {
    return await opts.fn();
  } finally {
    // Only release the lock if it's still ours — if fn() ran long enough
    // that another waiter reclaimed it as stale, deleting it now would
    // steal the new owner's lock out from under them.
    const current = await lockFs.read(opts.lockPath);
    const currentToken = current !== null ? parseLockToken(current) : null;
    if (currentToken === token) {
      await lockFs.remove(opts.lockPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Worktree gitdir verification
// ---------------------------------------------------------------------------

export type VerifyWorktreeGitdirOptions = {
  readonly run: CommandRunner;
  readonly repoDir: string;
  readonly dir: string;
  readonly readTextFile?: (path: string) => Promise<string>;
  readonly realpath?: (path: string) => Promise<string>;
};

/**
 * Before running git *inside* a worktree directory, confirm it's actually a
 * registered worktree of `repoDir` (per `git worktree list`), that its
 * `.git` file's `gitdir:` target — resolved with realpath, so neither `..`
 * nor a symlink can smuggle it elsewhere — is a direct child of
 * `realpath(<repoDir>/.git/worktrees)`, and that the admin dir's `gitdir`
 * back-pointer (the file `git worktree add` writes) names
 * `<realpath(dir)>/.git`. Throws otherwise — guards against operating on a
 * worktree directory whose `.git` file was redirected elsewhere (a
 * redirected gitdir brings its own `config`, e.g. a `filter.<x>.clean`
 * command the next `git add` would run).
 */
/** The admin dir a worktree `.git` file names, read the way git reads it
 * (the bytes after exactly "gitdir: ", minus one trailing LF or CRLF) — but
 * only when the file is the canonical form `git worktree add` writes:
 * an absolute path with no surrounding whitespace or control characters.
 * Anything else (two spaces, a tab, a trailing space, a relative path)
 * would make git read a directory other than the one a lenient parse sees,
 * so it is null. */
function parseCanonicalGitPointer(content: string): string | null {
  const body = content.endsWith("\r\n")
    ? content.slice(0, -2)
    : content.endsWith("\n")
      ? content.slice(0, -1)
      : content;
  const prefix = "gitdir: ";
  if (!body.startsWith(prefix)) return null;
  const path = body.slice(prefix.length);
  if (!path.startsWith("/")) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\x00-\x1f\x7f]/.test(path) || path !== path.trimEnd()) return null;
  return path;
}

export async function verifyWorktreeGitdir(
  opts: VerifyWorktreeGitdirOptions,
): Promise<void> {
  const entries = await listWorktrees({ run: opts.run, repoDir: opts.repoDir });
  const registered = entries.some((entry) => entry.path === opts.dir);
  if (!registered) {
    throw new Error(
      `worktree ${opts.dir} is not registered under ${opts.repoDir} (git worktree list)`,
    );
  }

  const readTextFile =
    opts.readTextFile ?? ((path: string) => readFile(path, "utf8"));
  const resolveReal = opts.realpath ?? ((path: string) => realpath(path));
  const target = parseCanonicalGitPointer(
    await readTextFile(`${opts.dir}/.git`),
  );
  const worktreesDir = `${opts.repoDir}/.git/worktrees`;
  const notUnder = new Error(
    `worktree ${opts.dir}: .git file does not point under ${worktreesDir}/`,
  );
  if (target === null) throw notUnder;
  let realTarget: string;
  let realWorktreesDir: string;
  try {
    realTarget = await resolveReal(target);
    realWorktreesDir = await resolveReal(worktreesDir);
  } catch {
    throw notUnder;
  }
  if (dirname(realTarget) !== realWorktreesDir) throw notUnder;

  const backPointer = (await readTextFile(`${realTarget}/gitdir`)).trim();
  const expectedBackPointer = `${await resolveReal(opts.dir)}/.git`;
  if (backPointer !== expectedBackPointer) {
    throw new Error(
      `worktree ${opts.dir}: the admin dir's gitdir back-pointer names ${backPointer}, not ${expectedBackPointer}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Worktree .git pointer snapshot (implement flow, 工程3 design §3)
// ---------------------------------------------------------------------------

/** The two fs calls readWorktreeGitPointer makes; injectable for tests. */
export type WorktreeGitPointerFs = {
  readonly lstat: (path: string) => Promise<{
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }>;
  readonly readFile: (path: string) => Promise<string>;
};

const defaultWorktreeGitPointerFs: WorktreeGitPointerFs = {
  lstat: (path) => lstat(path),
  readFile: (path) => readFile(path, "utf8"),
};

export const WORKTREE_GIT_POINTER_MODIFIED_MESSAGE =
  "worktree git pointer was modified";

/** A Claude run changed (or replaced) the worktree's `.git` file: the next
 * git command there would read another gitdir's config and hooks. */
export class WorktreeGitPointerModifiedError extends Error {
  constructor() {
    super(WORKTREE_GIT_POINTER_MODIFIED_MESSAGE);
    this.name = "WorktreeGitPointerModifiedError";
  }
}

/** `<worktreeDir>/.git`'s bytes — only when it is a regular file (lstat: not
 * a symlink, not a directory). implement_prepare records it right after the
 * worktree is ready, before any Claude run. */
export async function readWorktreeGitPointer(
  worktreeDir: string,
  fs: WorktreeGitPointerFs = defaultWorktreeGitPointerFs,
): Promise<{ readonly content: string }> {
  const path = `${worktreeDir}/.git`;
  const stats = await fs.lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`worktree ${worktreeDir}: .git is not a regular file`);
  }
  return { content: await fs.readFile(path) };
}

/** Re-reads `<worktreeDir>/.git` and throws WorktreeGitPointerModifiedError
 * when it differs from `expected` in any byte, is no longer a regular file,
 * or cannot be read at all. Call it after every Claude run, before the
 * first git command in the worktree. */
export async function assertWorktreeGitPointer(
  worktreeDir: string,
  expected: string,
  fs: WorktreeGitPointerFs = defaultWorktreeGitPointerFs,
): Promise<void> {
  let current: string;
  try {
    current = (await readWorktreeGitPointer(worktreeDir, fs)).content;
  } catch {
    throw new WorktreeGitPointerModifiedError();
  }
  if (current !== expected) throw new WorktreeGitPointerModifiedError();
}

// ---------------------------------------------------------------------------
// ensureRepo: fetch-only main clone at /workspaces/<owner>/<repo>/main
// ---------------------------------------------------------------------------

export type EnsureRepoOptions = {
  readonly run: CommandRunner;
  readonly owner: string;
  readonly repo: string;
  readonly ghToken: string;
  /** Default "/workspaces". */
  readonly baseDir?: string;
  readonly home?: string;
  readonly path?: string;
  readonly exists?: PathExists;
  readonly lockFs?: LockFs;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
};

export type EnsureRepoResult = {
  readonly dir: string;
  readonly action: "cloned" | "fetched";
};

/**
 * Ensure a fetch-only clone of `owner/repo` exists at
 * `<baseDir>/<owner>/<repo>/main`. Never checks out a working tree there
 * (spec-cycle2.md §7 item 2) — callers read files via a detached worktree
 * (`addDetachedWorktree`) or a `git gtr` worktree (`createGtrWorktree`).
 */
export async function ensureRepo(
  opts: EnsureRepoOptions,
): Promise<EnsureRepoResult> {
  assertGitHubName(opts.owner);
  assertGitHubName(opts.repo);

  const baseDir = opts.baseDir ?? "/workspaces";
  const parentDir = `${baseDir}/${opts.owner}/${opts.repo}`;
  const dir = `${parentDir}/main`;
  const exists = opts.exists ?? pathExists;

  await opts.run(["mkdir", "-p", parentDir]);

  return withRepoLock({
    lockPath: repoLockPath(dir),
    ...(opts.lockFs !== undefined ? { lockFs: opts.lockFs } : {}),
    ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    fn: async () => {
      if (await exists(dir)) {
        const result = await opts.run(
          buildGitArgv(["fetch", "--", "origin"], { network: true }),
          {
            cwd: dir,
            env: networkGitEnv(opts.ghToken, opts.home, opts.path),
          },
        );
        if (result.exitCode !== 0) {
          throw gitError(
            `git fetch failed for ${opts.owner}/${opts.repo}`,
            result,
          );
        }
        await persistNoSymlinksConfig(opts.run, dir, opts.home, opts.path);
        return { dir, action: "fetched" as const };
      }

      const url = `https://github.com/${opts.owner}/${opts.repo}.git`;
      const result = await opts.run(
        buildGitArgv(["clone", "--no-checkout", "--", url, dir], {
          network: true,
        }),
        { env: networkGitEnv(opts.ghToken, opts.home, opts.path) },
      );
      if (result.exitCode !== 0) {
        throw gitError(
          `git clone failed for ${opts.owner}/${opts.repo}`,
          result,
        );
      }
      await persistNoSymlinksConfig(opts.run, dir, opts.home, opts.path);
      return { dir, action: "cloned" as const };
    },
  });
}

/**
 * The sha `origin/HEAD` currently points at in a fetch-only `ensureRepo`
 * clone at `repoDir` — i.e. the target repo's current default-branch head.
 * Read-only and local-only: no `GH_TOKEN` needed, since `ensureRepo` must
 * already have fetched `origin` before this runs, making `origin/HEAD`
 * locally resolvable. Promoted from the M6 pipeline step's local copy
 * (`pipeline_prepare.ts`'s `resolveDefaultBranchHeadSha`) — same `-c`
 * hardening flags and `rev-parse --verify` (no `--`; see this module's
 * `rev-parse` exception note above) as every other git call here.
 */
export async function resolveDefaultBranchHeadSha(
  run: CommandRunner,
  repoDir: string,
): Promise<string> {
  const result = await run(
    buildGitArgv(["rev-parse", "--verify", "origin/HEAD"]),
    { cwd: repoDir, env: localGitEnv() },
  );
  if (result.exitCode !== 0) {
    throw gitError(
      `git rev-parse --verify origin/HEAD failed in ${repoDir}`,
      result,
    );
  }
  return result.stdout.trim();
}

/**
 * `git fetch origin -- pull/<prNumber>/head` in the fetch-only main clone —
 * guarantees the PR's current head commit is fetchable by sha even for a
 * commit that (unlike a branch tip) may not otherwise be reachable from any
 * ref the client already asked for. Promoted from the M6 pr_review step's
 * local copy (`pr_workflow_support.ts`'s `fetchPrHeadRef`). `prNumber` is
 * `number`-typed so it can never itself start with `-` once interpolated
 * after the literal `pull/` prefix, but the refspec still goes after `--`
 * for consistency with every other network git call in this module (and as
 * defense-in-depth against a future caller passing something looser than a
 * validated number).
 */
export async function fetchPrHeadRef(
  run: CommandRunner,
  repoDir: string,
  prNumber: number,
  ghToken: string,
  home?: string,
  path?: string,
): Promise<void> {
  const result = await run(
    buildGitArgv(["fetch", "origin", "--", `pull/${prNumber}/head`], {
      network: true,
    }),
    { cwd: repoDir, env: networkGitEnv(ghToken, home, path) },
  );
  if (result.exitCode !== 0) {
    throw gitError(
      `git fetch origin pull/${prNumber}/head failed in ${repoDir}`,
      result,
    );
  }
}

/**
 * `git show <ref>:<path>` in `dir` — the file's content at that ref, or
 * `null` when the file doesn't exist there (or `ref` fails validation, or
 * any other error) for a "does this file exist at HEAD" check that
 * shouldn't itself throw. Promoted from the M6 pr_fix step's local copy
 * (`pr_workflow_support.ts`'s `readGitShowFile`).
 *
 * `<ref>:<path>` is a *second*, git-show-specific exception to this
 * module's usual "untrusted positional args go after `--`" rule (see the
 * module doc comment's `rev-parse` exception) — verified empirically:
 * `git show -- HEAD:file.txt` does not error, but silently returns empty
 * output instead of the file's content (git parses the combined
 * `ref:path` token as a pathspec-only filter once it's past `--`, not as
 * an object reference), which would be a *worse* bug than the one `--`
 * is meant to prevent. Since `path` always follows `ref` and a literal
 * `:` inside the same argv entry, an untrusted `path` alone can never
 * make this entry start with `-` or shift the rev/path split (the split
 * happens on our own inserted `:`, not on anything `path` contributes);
 * only `ref` starting with `-` (or containing a stray `:`) is a risk, so
 * `ref` is validated via `assertBranchName` (rejects a leading `-`, `..`,
 * control/whitespace chars, and `:` among others) — caught rather than
 * left to propagate, to preserve this function's "never throws" contract.
 */
export async function readGitShowFile(
  run: CommandRunner,
  dir: string,
  ref: string,
  path: string,
  home?: string,
  envPath?: string,
): Promise<string | null> {
  try {
    assertBranchName(ref);
  } catch {
    return null;
  }
  const result = await run(buildGitArgv(["show", `${ref}:${path}`]), {
    cwd: dir,
    env: localGitEnv(home, envPath),
  });
  return result.exitCode === 0 ? result.stdout : null;
}

// ---------------------------------------------------------------------------
// ensureFactoryClone: real (checked-out) self clone used to read skills
// ---------------------------------------------------------------------------

const DEFAULT_FACTORY_CLONE_DIR = "/workspaces/factory/atelier-works";

export type EnsureFactoryCloneOptions = {
  readonly run: CommandRunner;
  readonly repoUrl: string;
  readonly ghToken: string;
  /** Default "/workspaces/factory/atelier-works". */
  readonly dir?: string;
  /**
   * Branch to check out and keep the clone on (config
   * `factory_config.factory_branch`, M7) — required, no default. Every
   * call site must pass `config.factory_branch` explicitly; there is no
   * safe default to fall back to, since a caller that forgets it would
   * silently pin the *shared* self clone to whatever this parameter
   * defaulted to (see this function's own module comment for the real
   * incident: with an optional `branch` defaulting to "main", one caller
   * omitting it kept resetting the clone away from the configured branch
   * out from under every other caller).
   */
  readonly branch: string;
  readonly home?: string;
  readonly path?: string;
  readonly exists?: PathExists;
  readonly lockFs?: LockFs;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
};

export type EnsureFactoryCloneResult = {
  readonly dir: string;
  readonly action: "cloned" | "pulled";
};

/**
 * The lock path scoping the factory self clone at `dir` — a sibling
 * `<dir>.lock` file, since (unlike `ensureRepo`'s `<baseDir>/<owner>/<repo>/
 * main` clones) there's no shared parent directory of same-repo siblings to
 * key off here; `dir` itself is the one resource to protect. Exported so
 * that other git operations on the self clone (audit_generate's snapshot
 * worktree add/remove) can take the same lock `ensureFactoryClone` takes;
 * the worktree helpers themselves lock `repoLockPath(dir)`, a different
 * file, so without this outer lock `self_update`'s `reset --hard` could
 * race a `worktree add` on the same clone.
 */
export function factoryCloneLockPath(dir: string): string {
  return `${dir}.lock`;
}

/**
 * Ensure the factory's own self clone exists, with a real (checked-out)
 * working tree, and is up to date on `opts.branch`. Unlike `ensureRepo`,
 * this clone is read for its files directly (`.claude/skills/<name>/
 * SKILL.md` via `claude.ts#buildSystemPrompt`), so it needs a working tree
 * rather than a fetch-only bare clone. Call at the start of every flow
 * (spec-cycle2.md §0).
 *
 * On every call — not just at first clone — this fetches `opts.branch` and
 * force-checks-out onto it (`checkout -B`), converging the clone to that
 * branch's current remote state regardless of what was checked out before
 * (M7 re-gate; see the incident below). Serialized under
 * `factoryCloneLockPath(dir)` (devil-advocate fix, security-auditor-
 * adopted): with `NUM_WORKERS` > 1, every flow's first step and
 * `poll_issues` all call this for the *same* `dir` concurrently; without a
 * lock, two `git fetch`/`git checkout`/`git clone` racing on the same
 * working tree fail on `.git/index.lock`.
 *
 * Real incident (M7, self_update's own second production run): with an
 * earlier version of this function that only checked out `opts.branch` on
 * a *fresh* clone (an already-existing clone was just `git pull --ff-
 * only`ed on whatever branch it happened to be on), one caller
 * (poll_issues.ts's `checkDeployedSha`, which reads the self clone but
 * doesn't deploy from it) omitted `branch` and got a default of "main" —
 * which, running every 5 minutes, kept resetting the *shared* clone back
 * to `main` in between self_update's own 10-minutely runs, so self_update
 * kept deploying stale `main` content instead of the real
 * `factory_branch`. Fixed two ways: this function now always re-converges
 * to `opts.branch` on every call (this comment), and `branch` has no
 * default (it is a required field on `EnsureFactoryCloneOptions`) so every
 * call site is forced to pass `config.factory_branch` explicitly — a
 * caller can no longer *silently* fall back to a wrong branch for the
 * whole shared clone.
 */
export async function ensureFactoryClone(
  opts: EnsureFactoryCloneOptions,
): Promise<EnsureFactoryCloneResult> {
  const dir = opts.dir ?? DEFAULT_FACTORY_CLONE_DIR;
  const branch = opts.branch;
  assertBranchName(branch);
  const exists = opts.exists ?? pathExists;
  const env = networkGitEnv(opts.ghToken, opts.home, opts.path);

  return withRepoLock({
    lockPath: factoryCloneLockPath(dir),
    ...(opts.lockFs !== undefined ? { lockFs: opts.lockFs } : {}),
    ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    fn: async () => {
      if (await exists(dir)) {
        // Fetch + `checkout -B` (not `pull --ff-only`), unconditionally, on
        // every call — not just at first clone (security/correctness fix,
        // M7 re-gate): `branch` (config `factory_branch`) can differ from
        // whatever branch this clone happened to be on already (e.g. a
        // *different* caller of ensureFactoryClone that didn't pass
        // `branch` defaults to "main" and leaves the clone checked out
        // there), and a plain `pull --ff-only` only ever advances the
        // *currently checked-out* branch — it neither switches branches nor
        // notices a mismatch. Verified in a real worker run: this let the
        // clone stay stuck on `main` while `factory_branch` was the actual
        // working branch, so self_update deployed stale `main` content.
        // `checkout -B <branch> origin/<branch>` always converges to the
        // configured branch's current remote state regardless of what was
        // checked out before (switching if needed, resetting hard if
        // already on it) - safe here since this clone is fetch-and-read
        // only, never edited in place.
        const fetchResult = await opts.run(
          buildGitArgv(["fetch", "origin", "--", branch], { network: true }),
          {
            cwd: dir,
            env,
          },
        );
        if (fetchResult.exitCode !== 0) {
          throw gitError(
            `git fetch origin ${branch} failed for factory clone`,
            fetchResult,
          );
        }
        // Discard any local modification first. This clone is read-only for
        // the factory, but `wmill sync push` bundles the raw app in place
        // and its `npm install` rewrites package-lock.json; a real worker
        // run then had `checkout -B` refuse to switch ("Your local changes
        // ... would be overwritten"), stalling self_update for good.
        const resetResult = await opts.run(buildGitArgv(["reset", "--hard"]), {
          cwd: dir,
          env: localGitEnv(opts.home, opts.path),
        });
        if (resetResult.exitCode !== 0) {
          throw gitError(
            "git reset --hard failed for factory clone",
            resetResult,
          );
        }
        // No `--` here: like `reset --hard` elsewhere in this module,
        // `checkout -B <branch> <start-point>` does not tolerate a `--`
        // before its start-point argument the way most other subcommands
        // do — `--` switches `checkout` into "restore these paths" mode,
        // silently misinterpreting `origin/<branch>` as a pathspec instead
        // of a ref. `branch` is validated via `assertBranchName` above
        // instead (rejects a leading `-`, `..`, control/whitespace chars).
        const checkoutResult = await opts.run(
          buildGitArgv(["checkout", "-B", branch, `origin/${branch}`]),
          {
            cwd: dir,
            env: localGitEnv(opts.home, opts.path),
          },
        );
        if (checkoutResult.exitCode !== 0) {
          throw gitError(
            `git checkout -B ${branch} origin/${branch} failed for factory clone`,
            checkoutResult,
          );
        }
        return { dir, action: "pulled" as const };
      }

      const result = await opts.run(
        buildGitArgv(
          [
            "clone",
            "--branch",
            branch,
            "--single-branch",
            "--",
            opts.repoUrl,
            dir,
          ],
          { network: true },
        ),
        {
          env,
        },
      );
      if (result.exitCode !== 0) {
        throw gitError("git clone failed for factory clone", result);
      }
      return { dir, action: "cloned" as const };
    },
  });
}

// ---------------------------------------------------------------------------
// Detached worktrees (pr_review, requirements generation)
// ---------------------------------------------------------------------------

export type AddDetachedWorktreeOptions = {
  readonly run: CommandRunner;
  readonly repoDir: string;
  readonly sha: string;
  readonly dir: string;
  readonly ghToken: string;
  readonly home?: string;
  readonly path?: string;
  readonly lockFs?: LockFs;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
};

/**
 * `git worktree add --detach <dir> <sha>`, fetching `sha` first. Serialized
 * under `repoLockPath(repoDir)` (code-review fix), same lock `ensureRepo`
 * uses for this repo.
 */
export async function addDetachedWorktree(
  opts: AddDetachedWorktreeOptions,
): Promise<{ readonly dir: string }> {
  assertSha(opts.sha);

  return withRepoLock({
    lockPath: repoLockPath(opts.repoDir),
    ...(opts.lockFs !== undefined ? { lockFs: opts.lockFs } : {}),
    ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    fn: async () => {
      const fetchResult = await opts.run(
        buildGitArgv(["fetch", "origin", "--", opts.sha], { network: true }),
        {
          cwd: opts.repoDir,
          env: networkGitEnv(opts.ghToken, opts.home, opts.path),
        },
      );
      if (fetchResult.exitCode !== 0) {
        throw gitError(`git fetch ${opts.sha} failed`, fetchResult);
      }

      // `-c core.symlinks=false` (security fix, medium): a committed
      // symlink (e.g. one pointing at `/proc/self/environ` or another
      // path outside the worktree) would otherwise be checked out as a
      // real symlink here; this forces it to be checked out as the plain
      // text of its target path instead, same as `git clone -c
      // core.symlinks=false`.
      const addResult = await opts.run(
        buildGitArgv([
          "-c",
          "core.symlinks=false",
          "worktree",
          "add",
          "--detach",
          "--",
          opts.dir,
          opts.sha,
        ]),
        { cwd: opts.repoDir, env: localGitEnv(opts.home, opts.path) },
      );
      if (addResult.exitCode !== 0) {
        throw gitError("git worktree add --detach failed", addResult);
      }

      return { dir: opts.dir };
    },
  });
}

/** The fs calls behind the `.git` pointer check (verifyWorktreeGitdir) and
 * the fs-only removal of a worktree that fails it; injectable for tests. */
export type WorktreeFsDeps = {
  readonly readTextFile?: (path: string) => Promise<string>;
  readonly realpath?: (path: string) => Promise<string>;
  /** `rm -rf`; defaults to `rm(path, { recursive: true, force: true })`. */
  readonly removeDir?: (path: string) => Promise<void>;
};

/** Whether `dir`'s `.git` pointer passes verifyWorktreeGitdir. */
async function worktreePointerVerified(opts: {
  readonly run: CommandRunner;
  readonly repoDir: string;
  readonly dir: string;
  readonly fs: WorktreeFsDeps | undefined;
}): Promise<boolean> {
  try {
    await verifyWorktreeGitdir({
      run: opts.run,
      repoDir: opts.repoDir,
      dir: opts.dir,
      ...(opts.fs?.readTextFile !== undefined
        ? { readTextFile: opts.fs.readTextFile }
        : {}),
      ...(opts.fs?.realpath !== undefined
        ? { realpath: opts.fs.realpath }
        : {}),
    });
    return true;
  } catch {
    return false;
  }
}

/** Deletes a worktree whose `.git` pointer failed verification without
 * running git inside it (a redirected pointer brings its own config, e.g.
 * a clean filter): `rm -rf` through the fs, then `git worktree prune` from
 * `repoDir`. Only a path `git worktree list` (run in `repoDir`) reports,
 * other than the main clone, and lying strictly under the repository's
 * workspace dir (`dirname(repoDir)`, e.g. `/workspaces/<owner>/<repo>`) is
 * deleted; anything else throws. Call under the repo lock. */
async function discardUnverifiedWorktree(opts: {
  readonly run: CommandRunner;
  readonly repoDir: string;
  readonly dir: string;
  readonly home?: string;
  readonly path?: string;
  readonly fs: WorktreeFsDeps | undefined;
}): Promise<void> {
  const entries = await listWorktrees({
    run: opts.run,
    repoDir: opts.repoDir,
    ...(opts.home !== undefined ? { home: opts.home } : {}),
    ...(opts.path !== undefined ? { path: opts.path } : {}),
  });
  if (
    opts.dir === opts.repoDir ||
    !entries.some((entry) => entry.path === opts.dir)
  ) {
    throw new Error(
      `refusing to delete ${opts.dir}: not a registered worktree of ${opts.repoDir}`,
    );
  }
  const root = dirname(opts.repoDir);
  if (resolve(opts.dir) !== opts.dir || !opts.dir.startsWith(`${root}/`)) {
    throw new Error(
      `refusing to delete ${opts.dir}: outside the repository's workspace dir ${root}`,
    );
  }
  const removeDir =
    opts.fs?.removeDir ??
    ((path: string) => rm(path, { recursive: true, force: true }));
  await removeDir(opts.dir);
  const prune = await opts.run(buildGitArgv(["worktree", "prune"]), {
    cwd: opts.repoDir,
    env: localGitEnv(opts.home, opts.path),
  });
  if (prune.exitCode !== 0) {
    throw gitError("git worktree prune failed", prune);
  }
}

export type RemoveWorktreeOptions = {
  readonly run: CommandRunner;
  readonly repoDir: string;
  readonly dir: string;
  readonly force?: boolean;
  readonly home?: string;
  readonly path?: string;
  readonly lockFs?: LockFs;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  readonly fs?: WorktreeFsDeps;
};

/** Serialized under `repoLockPath(repoDir)` (code-review fix), same lock
 * `ensureRepo` uses for this repo. `git worktree remove` inspects the
 * worktree, so it runs only after the `.git` pointer passes
 * verifyWorktreeGitdir; otherwise the directory is deleted through the fs
 * (discardUnverifiedWorktree). */
export async function removeWorktree(
  opts: RemoveWorktreeOptions,
): Promise<void> {
  await withRepoLock({
    lockPath: repoLockPath(opts.repoDir),
    ...(opts.lockFs !== undefined ? { lockFs: opts.lockFs } : {}),
    ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    fn: async () => {
      if (
        !(await worktreePointerVerified({
          run: opts.run,
          repoDir: opts.repoDir,
          dir: opts.dir,
          fs: opts.fs,
        }))
      ) {
        await discardUnverifiedWorktree({
          run: opts.run,
          repoDir: opts.repoDir,
          dir: opts.dir,
          ...(opts.home !== undefined ? { home: opts.home } : {}),
          ...(opts.path !== undefined ? { path: opts.path } : {}),
          fs: opts.fs,
        });
        return;
      }
      const args = [
        "worktree",
        "remove",
        ...(opts.force === true ? ["--force"] : []),
        "--",
        opts.dir,
      ];
      const result = await opts.run(buildGitArgv(args), {
        cwd: opts.repoDir,
        env: localGitEnv(opts.home, opts.path),
      });
      if (result.exitCode !== 0) {
        throw gitError("git worktree remove failed", result);
      }
      await opts.run(buildGitArgv(["worktree", "prune"]), {
        cwd: opts.repoDir,
        env: localGitEnv(opts.home, opts.path),
      });
    },
  });
}

export type PruneWorktreesOptions = {
  readonly run: CommandRunner;
  readonly repoDir: string;
  readonly home?: string;
  readonly path?: string;
  readonly lockFs?: LockFs;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
};

/**
 * `git worktree prune` in `repoDir` on its own — for a standalone sweep
 * (cleanup_workspaces.ts, M7) that isn't itself removing a specific entry
 * via `removeWorktree` (which already prunes after every removal). Clears
 * stale worktree administrative metadata for a working tree directory that
 * no longer exists on disk (e.g. removed outside of git). Serialized under
 * `repoLockPath(repoDir)` (same lock every other worktree-mutating function
 * in this module uses for this repo).
 */
export async function pruneWorktrees(
  opts: PruneWorktreesOptions,
): Promise<void> {
  await withRepoLock({
    lockPath: repoLockPath(opts.repoDir),
    ...(opts.lockFs !== undefined ? { lockFs: opts.lockFs } : {}),
    ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    fn: async () => {
      const result = await opts.run(buildGitArgv(["worktree", "prune"]), {
        cwd: opts.repoDir,
        env: localGitEnv(opts.home, opts.path),
      });
      if (result.exitCode !== 0) {
        throw gitError("git worktree prune failed", result);
      }
    },
  });
}

export type WorktreeEntry = {
  readonly path: string;
  readonly headSha: string | null;
  readonly branch: string | null;
  readonly bare: boolean;
  readonly detached: boolean;
};

function parseWorktreeListPorcelain(stdout: string): WorktreeEntry[] {
  const blocks = stdout
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.length > 0);

  return blocks.map((block) => {
    let path: string | null = null;
    let headSha: string | null = null;
    let branch: string | null = null;
    let bare = false;
    let detached = false;

    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) {
        path = line.slice("worktree ".length);
      } else if (line.startsWith("HEAD ")) {
        headSha = line.slice("HEAD ".length);
      } else if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length);
        branch = ref.startsWith("refs/heads/")
          ? ref.slice("refs/heads/".length)
          : ref;
      } else if (line === "bare") {
        bare = true;
      } else if (line === "detached") {
        detached = true;
      }
    }

    if (path === null) {
      throw new Error(
        `unexpected 'git worktree list --porcelain' block: ${block}`,
      );
    }
    return { path, headSha, branch, bare, detached };
  });
}

export async function listWorktrees(opts: {
  readonly run: CommandRunner;
  readonly repoDir: string;
  readonly home?: string;
  readonly path?: string;
}): Promise<WorktreeEntry[]> {
  const result = await opts.run(
    buildGitArgv(["worktree", "list", "--porcelain"]),
    {
      cwd: opts.repoDir,
      env: localGitEnv(opts.home, opts.path),
    },
  );
  if (result.exitCode !== 0) {
    throw gitError("git worktree list failed", result);
  }
  return parseWorktreeListPorcelain(result.stdout);
}

// ---------------------------------------------------------------------------
// git gtr worktrees (pr_fix)
// ---------------------------------------------------------------------------

export type GtrWorktree = {
  readonly path: string;
  readonly branch: string;
  readonly hookStatus: string;
};

function parseGtrPorcelain(stdout: string): GtrWorktree {
  const fields = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const tabIndex = line.indexOf("\t");
    if (tabIndex === -1) continue;
    fields.set(line.slice(0, tabIndex), line.slice(tabIndex + 1));
  }

  const path = fields.get("path");
  const branch = fields.get("branch");
  const hookStatus = fields.get("hook_status");
  if (path === undefined || branch === undefined || hookStatus === undefined) {
    throw new Error(`unexpected 'git gtr new --porcelain' output: ${stdout}`);
  }
  return { path, branch, hookStatus };
}

export type CreateGtrWorktreeOptions = {
  readonly run: CommandRunner;
  readonly repoDir: string;
  readonly branch: string;
  readonly ghToken: string;
  readonly home?: string;
  readonly path?: string;
  readonly lockFs?: LockFs;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  readonly fs?: WorktreeFsDeps;
};

/**
 * `git gtr new <branch> --porcelain --yes`, reusing an existing worktree for
 * `branch` if `git worktree list` already has one (spec-cycle2.md §1
 * workspace.ts "既存なら再利用"). Serialized under `repoLockPath(repoDir)`
 * (code-review fix), same lock `ensureRepo` uses for this repo. A reused
 * worktree's `.git` pointer is verified (verifyWorktreeGitdir) before any
 * git command runs inside it; one that fails is deleted through the fs
 * (discardUnverifiedWorktree) and recreated with `git gtr new`.
 */
export async function createGtrWorktree(
  opts: CreateGtrWorktreeOptions,
): Promise<GtrWorktree> {
  assertBranchName(opts.branch);

  return withRepoLock({
    lockPath: repoLockPath(opts.repoDir),
    ...(opts.lockFs !== undefined ? { lockFs: opts.lockFs } : {}),
    ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    fn: async () => {
      const existing = await listWorktrees({
        run: opts.run,
        repoDir: opts.repoDir,
        ...(opts.home !== undefined ? { home: opts.home } : {}),
        ...(opts.path !== undefined ? { path: opts.path } : {}),
      });
      const found = existing.find((entry) => entry.branch === opts.branch);
      const reused =
        found !== undefined &&
        (await worktreePointerVerified({
          run: opts.run,
          repoDir: opts.repoDir,
          dir: found.path,
          fs: opts.fs,
        }))
          ? found
          : undefined;
      if (found !== undefined && reused === undefined) {
        await discardUnverifiedWorktree({
          run: opts.run,
          repoDir: opts.repoDir,
          dir: found.path,
          ...(opts.home !== undefined ? { home: opts.home } : {}),
          ...(opts.path !== undefined ? { path: opts.path } : {}),
          fs: opts.fs,
        });
      }
      if (reused !== undefined) {
        // devil-advocate fix (adopted, fatal): a previous round's
        // timed-out/cancelled Claude run can leave stray edits sitting in
        // a reused worktree; without resetting to the branch's current
        // remote state first, those stray edits would get swept into the
        // *next* round's `git add -A` (commitAndPush), and — if a human
        // had since pushed to the branch directly — the reused worktree's
        // stale local history would also make the next push non-fast-
        // forward. Fetch, hard-reset, and clean back to a pristine
        // `origin/<branch>` state before handing the worktree back. New
        // worktrees (`git gtr new` below) don't need this: they're
        // created fresh from the current remote state already.
        const fetchResult = await opts.run(
          buildGitArgv(["fetch", "origin", "--", opts.branch], {
            network: true,
          }),
          {
            cwd: opts.repoDir,
            env: networkGitEnv(opts.ghToken, opts.home, opts.path),
          },
        );
        if (fetchResult.exitCode !== 0) {
          throw gitError(
            `git fetch origin ${opts.branch} failed (gtr worktree reuse)`,
            fetchResult,
          );
        }

        // No `--` here: like `rev-parse`/`show` above, `git reset --hard`
        // is a fourth documented exception — verified empirically:
        // `git reset --hard -- <ref>` fails outright ("fatal: Cannot do
        // hard reset with paths"), since `--hard` mode doesn't accept a
        // pathspec at all. `opts.branch` is already validated via
        // `assertBranchName` above.
        const resetResult = await opts.run(
          buildGitArgv(["reset", "--hard", `origin/${opts.branch}`]),
          { cwd: reused.path, env: localGitEnv(opts.home, opts.path) },
        );
        if (resetResult.exitCode !== 0) {
          throw gitError(
            `git reset --hard origin/${opts.branch} failed (gtr worktree reuse)`,
            resetResult,
          );
        }

        // `-fd`, not `-fdx`: this worktree belongs to an arbitrary target
        // repo whose own `.gitignore` may legitimately exclude heavy,
        // expensive-to-rebuild artifacts (`node_modules/`, build output,
        // ...) that a stale/cancelled run wouldn't itself have created —
        // `-x` would wipe those on every reuse for no correctness benefit.
        // The actual hazard here (a cancelled run's stray untracked/
        // modified files leaking into the next round's `git add -A`) is
        // already fully covered by plain untracked-file cleanup plus the
        // hard reset above (which already discards modifications to
        // tracked files).
        const cleanResult = await opts.run(buildGitArgv(["clean", "-fd"]), {
          cwd: reused.path,
          env: localGitEnv(opts.home, opts.path),
        });
        if (cleanResult.exitCode !== 0) {
          throw gitError(
            "git clean -fd failed (gtr worktree reuse)",
            cleanResult,
          );
        }

        return { path: reused.path, branch: opts.branch, hookStatus: "reused" };
      }

      // No `--` here: `git gtr` is a third-party subcommand (not core git)
      // and its own argv parsing isn't guaranteed to honor `--` the way
      // core git commands do; `assertBranchName` above already rejects a
      // leading `-`.
      const result = await opts.run(
        buildGitArgv(["gtr", "new", opts.branch, "--porcelain", "--yes"], {
          network: true,
        }),
        {
          cwd: opts.repoDir,
          // core.symlinks=false via env, not `-c` (see gitConfigEnvOverrides's
          // doc comment: `gtr` is a third-party wrapper, not core git).
          env: {
            ...networkGitEnv(opts.ghToken, opts.home, opts.path),
            ...gitConfigEnvOverrides({ "core.symlinks": "false" }),
          },
        },
      );
      if (result.exitCode !== 0) {
        throw gitError(`git gtr new ${opts.branch} failed`, result);
      }
      return parseGtrPorcelain(result.stdout);
    },
  });
}

// ---------------------------------------------------------------------------
// commitAndPush (pr_fix)
// ---------------------------------------------------------------------------

export type CommitAndPushOptions = {
  readonly run: CommandRunner;
  /** The main repo clone dir (see `ensureRepo`) this worktree belongs to — used to verify `dir` is a genuine, registered worktree before running git inside it, and to derive the shared per-repo lock. */
  readonly repoDir: string;
  readonly dir: string;
  readonly message: string;
  /** Factory instance name, embedded in the commit's `Generated-By` trailer (see `withCommitTrailers`). */
  readonly instanceName: string;
  /** The PR branch's remote head SHA observed when the caller started working. */
  readonly expectedHeadSha: string;
  /**
   * The `git commit`'s author/committer identity, passed via
   * `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env vars for that one invocation only —
   * never written to git config (see docs/security.md's "pr_fix の安全策").
   * Callers build this with `gitIdentityForViewer` (github.ts) from the
   * PAT's own viewer.
   */
  readonly author: GitIdentity;
  readonly ghToken: string;
  readonly home?: string;
  readonly path?: string;
  readonly verifyWorktree?: (
    opts: VerifyWorktreeGitdirOptions,
  ) => Promise<void>;
  readonly lockFs?: LockFs;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
};

export type CommitAndPushResult =
  | { readonly outcome: "pushed"; readonly newSha: string }
  | { readonly outcome: "head_changed"; readonly currentSha: string }
  | { readonly outcome: "nothing_to_commit" };

// A local (non-`--verify`) `rev-parse`/`push` failure due to the remote
// having moved is reported in the child's stderr with one of these
// substrings, across git's various phrasings ("[rejected]", "(non-fast-forward)",
// "hint: ... fetch first"). Matched case-insensitively. The bare word
// "rejected" is deliberately not a needle: a server-side refusal
// ("! [remote rejected] ... (refusing to allow a Personal Access Token to
// create or update workflow ...)", a declined pre-receive hook) also contains
// it, and treating that as a race would swallow a permanent failure as
// `head_changed` instead of surfacing it.
const PUSH_REJECTED_SUBSTRINGS = [
  "[rejected]",
  "non-fast-forward",
  "fetch first",
];

// A "[remote rejected]" line means the server refused the update for its
// own reasons; it is never a local non-fast-forward race, even if the same
// stderr happens to contain one of the needles above.
const REMOTE_REJECTED_SUBSTRING = "[remote rejected]";

function isNonFastForwardRejection(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  if (lower.includes(REMOTE_REJECTED_SUBSTRING)) {
    return false;
  }
  return PUSH_REJECTED_SUBSTRINGS.some((needle) => lower.includes(needle));
}

// User request (product decision, not security/audit-driven): every commit
// the factory makes should carry Claude attribution trailers.
const CLAUDE_COAUTHOR_TRAILER =
  "Co-Authored-By: Claude <noreply@anthropic.com>";

function generatedByTrailer(instanceName: string): string {
  return `Generated-By: Software Factory (${instanceName})`;
}

/**
 * `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_NAME`/
 * `GIT_COMMITTER_EMAIL` for `author` — merged into the `git commit`
 * invocation's env only (see `CommitAndPushOptions.author`'s doc comment).
 * Never written to git config, so it has no effect on any other git
 * invocation in this module.
 */
function commitIdentityEnv(author: GitIdentity): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  };
}

/**
 * Append the Claude co-author trailer and a `Generated-By: Software
 * Factory (<instanceName>)` trailer to `message`, separated from the rest
 * of the message by a blank line (git trailer convention) — unless
 * `message` already carries the co-author trailer, in which case it's
 * returned unchanged (idempotent: calling this twice, or on an already-
 * trailered message, doesn't double the trailers up). Pure function, no
 * I/O — used by `commitAndPush` before building the `git commit -m`
 * argv; author/committer identity itself is set separately, via
 * `CommitAndPushOptions.author` (`GIT_AUTHOR_*`/`GIT_COMMITTER_*` env vars
 * on the commit invocation only — see that field's doc comment).
 */
export function withCommitTrailers(
  message: string,
  instanceName: string,
): string {
  if (message.includes(CLAUDE_COAUTHOR_TRAILER)) {
    return message;
  }
  return `${message}\n\n${CLAUDE_COAUTHOR_TRAILER}\n${generatedByTrailer(instanceName)}`;
}

/**
 * Verify `dir` is a genuine worktree of `repoDir` (see
 * `verifyWorktreeGitdir`), fetch, verify the remote branch head still
 * matches `expectedHeadSha` (someone else may have pushed while Claude was
 * editing), then commit and push all working-tree changes. Token never
 * appears in the remote URL — auth goes through
 * `-c credential.helper='!gh auth git-credential'` with `GH_TOKEN` in the
 * subprocess env, only for the fetch/push steps. Serialized under
 * `repoLockPath(repoDir)` (code-review fix), same lock `ensureRepo` uses
 * for this repo. If `push` itself is rejected as non-fast-forward (a race
 * that slipped past the earlier head-sha check), re-fetches and returns
 * `{ outcome: "head_changed" }` instead of throwing.
 */
export async function commitAndPush(
  opts: CommitAndPushOptions,
): Promise<CommitAndPushResult> {
  assertSha(opts.expectedHeadSha);

  return withRepoLock({
    lockPath: repoLockPath(opts.repoDir),
    ...(opts.lockFs !== undefined ? { lockFs: opts.lockFs } : {}),
    ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    fn: async () => {
      const verify = opts.verifyWorktree ?? verifyWorktreeGitdir;
      await verify({ run: opts.run, repoDir: opts.repoDir, dir: opts.dir });

      const local = localGitEnv(opts.home, opts.path);
      const network = networkGitEnv(opts.ghToken, opts.home, opts.path);

      // No `--` on these `rev-parse` calls: verified empirically that `git
      // rev-parse -- <rev>` either breaks `--verify` ("Needed a single
      // revision") or echoes a literal `--` line in non-`--verify` mode —
      // see the module doc comment. `assertBranchName` below covers the
      // same "no leading `-`" concern.
      const branchResult = await opts.run(
        buildGitArgv(["rev-parse", "--abbrev-ref", "HEAD"]),
        { cwd: opts.dir, env: local },
      );
      if (branchResult.exitCode !== 0) {
        throw gitError("git rev-parse --abbrev-ref HEAD failed", branchResult);
      }
      const branch = branchResult.stdout.trim();
      assertBranchName(branch);

      const fetchResult = await opts.run(
        buildGitArgv(["fetch", "origin", "--", branch], { network: true }),
        { cwd: opts.dir, env: network },
      );
      if (fetchResult.exitCode !== 0) {
        throw gitError(`git fetch origin ${branch} failed`, fetchResult);
      }

      const remoteShaResult = await opts.run(
        buildGitArgv(["rev-parse", "--verify", `origin/${branch}`]),
        { cwd: opts.dir, env: local },
      );
      if (remoteShaResult.exitCode !== 0) {
        throw gitError(
          `git rev-parse --verify origin/${branch} failed`,
          remoteShaResult,
        );
      }
      const remoteSha = remoteShaResult.stdout.trim();
      if (remoteSha !== opts.expectedHeadSha) {
        return { outcome: "head_changed" as const, currentSha: remoteSha };
      }

      const addResult = await opts.run(buildGitArgv(["add", "-A"]), {
        cwd: opts.dir,
        env: local,
      });
      if (addResult.exitCode !== 0) {
        throw gitError("git add -A failed", addResult);
      }

      const statusResult = await opts.run(
        buildGitArgv(["status", "--porcelain"]),
        { cwd: opts.dir, env: local },
      );
      if (statusResult.stdout.trim().length === 0) {
        return { outcome: "nothing_to_commit" as const };
      }

      const commitResult = await opts.run(
        buildGitArgv([
          "commit",
          "-m",
          withCommitTrailers(opts.message, opts.instanceName),
        ]),
        {
          cwd: opts.dir,
          env: { ...local, ...commitIdentityEnv(opts.author) },
        },
      );
      if (commitResult.exitCode !== 0) {
        throw gitError("git commit failed", commitResult);
      }

      const pushResult = await opts.run(
        buildGitArgv(["push", "origin", "--", `HEAD:${branch}`], {
          network: true,
        }),
        { cwd: opts.dir, env: network },
      );
      if (pushResult.exitCode !== 0) {
        if (isNonFastForwardRejection(pushResult.stderr)) {
          const refetchResult = await opts.run(
            buildGitArgv(["fetch", "origin", "--", branch], {
              network: true,
            }),
            { cwd: opts.dir, env: network },
          );
          if (refetchResult.exitCode !== 0) {
            throw gitError(
              `git fetch origin ${branch} failed (after push rejection)`,
              refetchResult,
            );
          }
          const currentShaResult = await opts.run(
            buildGitArgv(["rev-parse", "--verify", `origin/${branch}`]),
            { cwd: opts.dir, env: local },
          );
          if (currentShaResult.exitCode !== 0) {
            throw gitError(
              `git rev-parse --verify origin/${branch} failed (after push rejection)`,
              currentShaResult,
            );
          }
          return {
            outcome: "head_changed" as const,
            currentSha: currentShaResult.stdout.trim(),
          };
        }
        throw gitError("git push failed", pushResult);
      }

      const newShaResult = await opts.run(
        buildGitArgv(["rev-parse", "--verify", "HEAD"]),
        { cwd: opts.dir, env: local },
      );
      if (newShaResult.exitCode !== 0) {
        throw gitError("git rev-parse --verify HEAD failed", newShaResult);
      }
      return {
        outcome: "pushed" as const,
        newSha: newShaResult.stdout.trim(),
      };
    },
  });
}

// ---------------------------------------------------------------------------
// pushNewBranch (implement flow): publish a freshly created local branch
// ---------------------------------------------------------------------------

export type PushNewBranchOptions = {
  readonly run: CommandRunner;
  /** The main repo clone dir (see `ensureRepo`) — derives the shared
   * per-repo lock, and both git calls run here: worktrees share refs and
   * config with the main clone, so `push -u` from repoDir publishes the
   * branch `createGtrWorktree` made and sets its upstream just the same. */
  readonly repoDir: string;
  readonly branch: string;
  readonly ghToken: string;
  readonly home?: string;
  readonly path?: string;
  readonly lockFs?: LockFs;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
};

export type PushNewBranchResult = { readonly pushed: boolean };

// `git ls-remote --exit-code` exits 2 when no ref matched (and 0 when one
// did); every other non-zero exit is a real failure (auth, network, ...).
const LS_REMOTE_NO_MATCH_EXIT_CODE = 2;

/**
 * `git push -u origin <branch>` from `repoDir`, right after
 * `createGtrWorktree` made the branch locally (工程3 design §0b): with the
 * branch published (even empty), every later step can use the existing
 * `commitAndPush` unchanged — it fetches `origin/<branch>` and compares
 * against `expectedHeadSha` — and `createGtrWorktree`'s reuse path can
 * `reset --hard origin/<branch>` on a retry. A no-op (`pushed: false`) when
 * the remote already has the branch (a retry after the push already
 * happened). The remote is asked directly with `git ls-remote --exit-code
 * --heads origin -- <branch>` (exit 0 = present, 2 = absent, anything else
 * is an error) rather than trusting the local `origin/<branch>`: `ensureRepo`
 * fetches without `--prune`, so a stale tracking ref left behind after a
 * human deleted the branch on GitHub must not suppress the push. Serialized
 * under `repoLockPath(repoDir)` like every other network git op on this repo.
 */
export async function pushNewBranch(
  opts: PushNewBranchOptions,
): Promise<PushNewBranchResult> {
  assertBranchName(opts.branch);

  return withRepoLock({
    lockPath: repoLockPath(opts.repoDir),
    ...(opts.lockFs !== undefined ? { lockFs: opts.lockFs } : {}),
    ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    fn: async () => {
      const env = networkGitEnv(opts.ghToken, opts.home, opts.path);
      const existing = await opts.run(
        buildGitArgv(
          ["ls-remote", "--exit-code", "--heads", "origin", "--", opts.branch],
          { network: true },
        ),
        { cwd: opts.repoDir, env },
      );
      if (existing.exitCode === 0) {
        return { pushed: false };
      }
      if (existing.exitCode !== LS_REMOTE_NO_MATCH_EXIT_CODE) {
        throw gitError(`git ls-remote origin ${opts.branch} failed`, existing);
      }

      const pushResult = await opts.run(
        buildGitArgv(["push", "-u", "origin", "--", opts.branch], {
          network: true,
        }),
        { cwd: opts.repoDir, env },
      );
      if (pushResult.exitCode !== 0) {
        throw gitError(`git push -u origin ${opts.branch} failed`, pushResult);
      }
      return { pushed: true };
    },
  });
}

// ---------------------------------------------------------------------------
// deleteRemoteBranch / currentRemoteHeadSha (implement flow)
// ---------------------------------------------------------------------------

export type DeleteRemoteBranchOptions = {
  readonly run: CommandRunner;
  readonly repoDir: string;
  readonly branch: string;
  readonly ghToken: string;
  readonly home?: string;
  readonly path?: string;
  readonly lockFs?: LockFs;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
};

export type DeleteRemoteBranchResult = { readonly deleted: boolean };

// git's own phrasing when `push --delete` names a branch the remote no
// longer has ("error: unable to delete '<b>': remote ref does not exist").
const REMOTE_REF_MISSING_SUBSTRING = "remote ref does not exist";

/**
 * `git push --delete origin <branch>` from the main clone (工程3 design
 * §0b / §13: a `requirements_gap` exit with no PR yet removes the empty or
 * half-done branch so the re-implementation after re-approval starts
 * clean). `deleted: false` (no throw) when the remote ref is already gone.
 */
export async function deleteRemoteBranch(
  opts: DeleteRemoteBranchOptions,
): Promise<DeleteRemoteBranchResult> {
  assertBranchName(opts.branch);

  return withRepoLock({
    lockPath: repoLockPath(opts.repoDir),
    ...(opts.lockFs !== undefined ? { lockFs: opts.lockFs } : {}),
    ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    fn: async () => {
      const result = await opts.run(
        buildGitArgv(["push", "--delete", "origin", "--", opts.branch], {
          network: true,
        }),
        {
          cwd: opts.repoDir,
          env: networkGitEnv(opts.ghToken, opts.home, opts.path),
        },
      );
      if (result.exitCode === 0) return { deleted: true };
      if (result.stderr.toLowerCase().includes(REMOTE_REF_MISSING_SUBSTRING)) {
        return { deleted: false };
      }
      throw gitError(`git push --delete origin ${opts.branch} failed`, result);
    },
  });
}

export type CurrentRemoteHeadShaOptions = {
  readonly run: CommandRunner;
  readonly repoDir: string;
  readonly branch: string;
  readonly home?: string;
  readonly path?: string;
};

/**
 * The sha `origin/<branch>` currently points at in `repoDir`, or `null`
 * when the remote-tracking ref does not exist locally (never fetched, or
 * the branch was deleted). Read-only and local-only, like
 * `resolveDefaultBranchHeadSha`; the caller fetches first when it needs
 * the remote's current state. The result feeds `commitAndPush`'s
 * `expectedHeadSha`, so it is validated with `assertSha` here.
 */
export async function currentRemoteHeadSha(
  opts: CurrentRemoteHeadShaOptions,
): Promise<string | null> {
  assertBranchName(opts.branch);
  const result = await opts.run(
    buildGitArgv(["rev-parse", "--verify", `origin/${opts.branch}`]),
    { cwd: opts.repoDir, env: localGitEnv(opts.home, opts.path) },
  );
  if (result.exitCode !== 0) return null;
  const sha = result.stdout.trim();
  assertSha(sha);
  return sha;
}

// ---------------------------------------------------------------------------
// resolveDefaultBranchName / mergeBaseSha / deleteLocalBranch (implement flow)
// ---------------------------------------------------------------------------

const ORIGIN_PREFIX = "origin/";

/** The target repo's default branch name from the `ensureRepo` clone's
 * `refs/remotes/origin/HEAD` symbolic ref (measured: `origin/main` on a
 * `--no-checkout` clone) — the base the implement flow opens its PR
 * against, and the ref `git gtr new` branches a new worktree from.
 * Local-only; `ensureRepo` must have run first. */
export async function resolveDefaultBranchName(opts: {
  readonly run: CommandRunner;
  readonly repoDir: string;
  readonly home?: string;
  readonly path?: string;
}): Promise<string> {
  const result = await opts.run(
    buildGitArgv(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]),
    {
      cwd: opts.repoDir,
      env: localGitEnv(opts.home, opts.path),
    },
  );
  if (result.exitCode !== 0) {
    throw gitError(
      `git symbolic-ref refs/remotes/origin/HEAD failed in ${opts.repoDir}`,
      result,
    );
  }
  const ref = result.stdout.trim();
  if (!ref.startsWith(ORIGIN_PREFIX)) {
    throw new Error(`unexpected origin/HEAD target: ${JSON.stringify(ref)}`);
  }
  const branch = ref.slice(ORIGIN_PREFIX.length);
  assertBranchName(branch);
  return branch;
}

export type WorktreeGitOptions = {
  readonly run: CommandRunner;
  readonly worktreeDir: string;
  readonly home?: string;
  readonly path?: string;
};

/** `git merge-base origin/<baseBranch> HEAD` in the implement worktree —
 * the point the branch left the default branch. The implement flow
 * compares every round against it, so changes committed earlier on the
 * branch (a needs_human partial push, an existing PR) stay visible. `--`
 * precedes the revisions per this module's rule (`git merge-base -- <a> <b>`
 * resolves the same way as without it; `baseBranch` is additionally
 * validated by assertBranchName). */
export async function mergeBaseSha(
  opts: WorktreeGitOptions & { readonly baseBranch: string },
): Promise<string> {
  assertBranchName(opts.baseBranch);
  const result = await opts.run(
    buildGitArgv(["merge-base", "--", `origin/${opts.baseBranch}`, "HEAD"]),
    {
      cwd: opts.worktreeDir,
      env: localGitEnv(opts.home, opts.path),
    },
  );
  if (result.exitCode !== 0) {
    throw gitError(
      `git merge-base origin/${opts.baseBranch} HEAD failed in ${opts.worktreeDir}`,
      result,
    );
  }
  const sha = result.stdout.trim();
  assertSha(sha);
  return sha;
}

export type DeleteLocalBranchOptions = {
  readonly run: CommandRunner;
  readonly repoDir: string;
  readonly branch: string;
  readonly home?: string;
  readonly path?: string;
  readonly lockFs?: LockFs;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
};

export type DeleteLocalBranchResult = { readonly deleted: boolean };

// git's phrasing for `branch -D` on a missing branch (measured:
// "error: branch '<b>' not found", exit 1).
const LOCAL_BRANCH_MISSING_SUBSTRING = "not found";

/** `git branch -D -- <branch>` in the main clone (工程3 design §14:
 * `removeWorktree` keeps the local branch, so a `requirements_gap` exit with
 * no PR drops it too, or the re-implementation after re-approval would
 * start from the stale branch). Remove the worktree first — git refuses to
 * delete a checked-out branch. */
export async function deleteLocalBranch(
  opts: DeleteLocalBranchOptions,
): Promise<DeleteLocalBranchResult> {
  assertBranchName(opts.branch);
  return withRepoLock({
    lockPath: repoLockPath(opts.repoDir),
    ...(opts.lockFs !== undefined ? { lockFs: opts.lockFs } : {}),
    ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    fn: async () => {
      const result = await opts.run(
        buildGitArgv(["branch", "-D", "--", opts.branch]),
        {
          cwd: opts.repoDir,
          env: localGitEnv(opts.home, opts.path),
        },
      );
      if (result.exitCode === 0) return { deleted: true };
      if (result.stderr.toLowerCase().includes(LOCAL_BRANCH_MISSING_SUBSTRING))
        return { deleted: false };
      throw gitError(`git branch -D ${opts.branch} failed`, result);
    },
  });
}

// ---------------------------------------------------------------------------
// worktreeFingerprint / runGitleaksOnWorktree (implement flow verify loop)
// ---------------------------------------------------------------------------

async function stageAll(opts: WorktreeGitOptions): Promise<void> {
  const result = await opts.run(buildGitArgv(["add", "-A"]), {
    cwd: opts.worktreeDir,
    env: localGitEnv(opts.home, opts.path),
  });
  if (result.exitCode !== 0)
    throw gitError(`git add -A failed in ${opts.worktreeDir}`, result);
}

/** `git clean -fdX` in the implement worktree: removes ignored files only
 * (capital X — untracked, non-ignored files are Claude's work and stay).
 * Runs before every round's check commands, so nothing a previous command
 * left in an ignored path (`node_modules/`, build output, caches) — possibly
 * shaped by Claude's earlier code — carries into the next run; check
 * commands install their dependencies themselves. */
export async function removeIgnoredFiles(
  opts: WorktreeGitOptions,
): Promise<void> {
  const result = await opts.run(buildGitArgv(["clean", "-fdX"]), {
    cwd: opts.worktreeDir,
    env: localGitEnv(opts.home, opts.path),
  });
  if (result.exitCode !== 0)
    throw gitError(`git clean -fdX failed in ${opts.worktreeDir}`, result);
}

function countOrZero(text: string | undefined): number {
  if (text === undefined || text === "-") return 0;
  const value = Number(text);
  return Number.isFinite(value) ? value : 0;
}

/** `git diff --numstat` totals: one file per non-blank line, a binary
 * file's `-` counts contribute 0 (it still counts as a file). */
export function parseNumstatTotals(stdout: string): ImplementDiffStat {
  let files = 0;
  let added = 0;
  let deleted = 0;
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    const [addedText, deletedText] = line.split("\t");
    files += 1;
    added += countOrZero(addedText);
    deleted += countOrZero(deletedText);
  }
  return { files, added, deleted };
}

export type WorktreeFingerprint = {
  /** `git write-tree` of the fully staged worktree: identical iff the
   * worktree content (untracked files included) is identical. */
  readonly treeSha: string;
  /** Staged state vs `baseSha`; `files === 0` means nothing differs from the base. */
  readonly diffStat: ImplementDiffStat;
};

/** Stages every change (`git add -A`) and returns `git write-tree` of the
 * result — the tree a commit made right now would record. implement_finish
 * compares it with the loop's verified_tree_sha before committing. */
export async function stagedTreeSha(opts: WorktreeGitOptions): Promise<string> {
  await stageAll(opts);
  const tree = await opts.run(buildGitArgv(["write-tree"]), {
    cwd: opts.worktreeDir,
    env: localGitEnv(opts.home, opts.path),
  });
  if (tree.exitCode !== 0)
    throw gitError(`git write-tree failed in ${opts.worktreeDir}`, tree);
  const treeSha = tree.stdout.trim();
  assertSha(treeSha);
  return treeSha;
}

/** Stages every change (`git add -A`; harmless for the later
 * `commitAndPush`, which stages again), fingerprints the staged state with
 * `git write-tree` (stall detection; design §14: plain `git diff` would
 * miss new files), and measures it against `baseSha` with
 * `git diff --cached --numstat` (implement_rounds.diff_stat and the
 * diff-size guard). */
export async function worktreeFingerprint(
  opts: WorktreeGitOptions & { readonly baseSha: string },
): Promise<WorktreeFingerprint> {
  assertSha(opts.baseSha);
  const treeSha = await stagedTreeSha(opts);
  const env = localGitEnv(opts.home, opts.path);
  const numstat = await opts.run(
    buildGitArgv([
      "diff",
      "--cached",
      "--numstat",
      "--no-ext-diff",
      "--no-textconv",
      opts.baseSha,
      "--",
    ]),
    { cwd: opts.worktreeDir, env },
  );
  if (numstat.exitCode !== 0) {
    throw gitError(
      `git diff --cached --numstat failed in ${opts.worktreeDir}`,
      numstat,
    );
  }
  return { treeSha, diffStat: parseNumstatTotals(numstat.stdout) };
}

export type GitleaksResult = { readonly ok: boolean; readonly output: string };

export type GitleaksConfigDir = {
  readonly path: string;
  readonly cleanup: () => Promise<void>;
};

const GITLEAKS_CONFIG_FILE = "gitleaks.toml";

/** gitleaks' built-in rules with nothing on top, forced with `--config` so a
 * `.gitleaks.toml` in the target repo (possibly written by Claude) cannot
 * allowlist anything — and a malformed one cannot abort the scan. The same
 * private dir is the `--gitleaks-ignore-path` (and the scan's cwd), so a
 * repo `.gitleaksignore` is not read, and `--ignore-gitleaks-allow` voids
 * inline `gitleaks:allow` comments (design §3: the scan is independent of
 * the repo's settings). */
export const GITLEAKS_DEFAULT_ONLY_CONFIG = "[extend]\nuseDefault = true\n";

const GITLEAKS_LEAKS_EXIT_CODE = 1;
const GITLEAKS_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Ceiling on the staged diff fed to gitleaks. A diff cut by the cap would
 * leave its middle unscanned, so hitting it fails the scan. */
const GITLEAKS_MAX_DIFF_BYTES = 32 * 1024 * 1024;

const defaultCreateGitleaksConfigDir = async (): Promise<GitleaksConfigDir> => {
  const dir = await mkdtemp(join(tmpdir(), "factory-gitleaks-"));
  try {
    await writeFile(
      join(dir, GITLEAKS_CONFIG_FILE),
      GITLEAKS_DEFAULT_ONLY_CONFIG,
      { mode: 0o600 },
    );
  } catch (err) {
    // The caller's try/finally only starts once this helper returns, so a
    // failed write must remove the directory it just created.
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return {
    path: dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
};

type GitleaksFinding = {
  readonly RuleID: string;
  readonly File: string;
  readonly StartLine: number;
};

function isGitleaksFinding(value: unknown): value is GitleaksFinding {
  return (
    isRecord(value) &&
    isString(value.RuleID) &&
    isString(value.File) &&
    isNumber(value.StartLine)
  );
}

const C_QUOTE_ESCAPES: Readonly<Record<string, number>> = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  '"': 0x22,
  "\\": 0x5c,
};

/** Undoes git's C-style quoting of a path (the text between the quotes):
 * `\t \n \" \\` and the other single-letter escapes, and `\NNN` octal
 * bytes (UTF-8, decoded as a whole). null for a malformed escape. */
function unquoteCStyle(quoted: string): string | null {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 0; i < quoted.length; i += 1) {
    const char = quoted.charAt(i);
    if (char !== "\\") {
      bytes.push(...encoder.encode(char));
      continue;
    }
    const next = quoted.charAt(i + 1);
    const octal = quoted.slice(i + 1, i + 4);
    if (/^[0-3][0-7]{2}$/.test(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      i += 3;
      continue;
    }
    const escaped = C_QUOTE_ESCAPES[next];
    if (escaped === undefined) return null;
    bytes.push(escaped);
    i += 1;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** The new-side path of a `+++ ` file header line: the path for
 * `+++ b/<path>` (git appends one tab to a name containing a space; it is
 * dropped) or git's C-quoted `+++ "b/<path>"` (unescaped), null for
 * `+++ /dev/null` (a deletion), undefined for any other line. */
function newPathFromHeader(line: string): string | null | undefined {
  const text = line.endsWith("\t") ? line.slice(0, -1) : line;
  if (text === "+++ /dev/null") return null;
  if (text.startsWith("+++ b/")) return text.slice("+++ b/".length);
  if (text.startsWith('+++ "b/') && text.endsWith('"') && text.length > 7) {
    const path = unquoteCStyle(text.slice('+++ "b/'.length, -1));
    return path ?? undefined;
  }
  return undefined;
}

/**
 * The file a 1-based `line` of a `git diff` text belongs to: the path of
 * the nearest preceding `+++ b/<path>` header of the same file section.
 * Headers are only read between a `diff --git` line and its first `@@`
 * hunk, so an added line whose content looks like a header (`+++ b/x`
 * inside a hunk) is never taken for one. null before any header and in a
 * deleted file's section (`+++ /dev/null`). gitleaks' stdin findings carry
 * no file name, only this line number.
 */
export function mapDiffLineToFile(
  diffText: string,
  line: number,
): string | null {
  const lines = diffText.split("\n");
  let file: string | null = null;
  let inHeader = false;
  for (const text of lines.slice(0, Math.max(0, line))) {
    if (text.startsWith("diff --git ")) {
      inHeader = true;
      file = null;
      continue;
    }
    if (!inHeader) continue;
    if (text.startsWith("@@")) {
      inHeader = false;
      continue;
    }
    const path = newPathFromHeader(text);
    if (path !== undefined) file = path;
  }
  return file;
}

/** `diffText` without the removed (`-`) lines of its hunks — the scan
 * checks what the branch adds, as `gitleaks git` did; a removed line
 * already exists in the base. File headers (`--- a/<path>`) are kept: they
 * are outside hunks. */
export function dropRemovedDiffLines(diffText: string): string {
  let inHunk = false;
  const kept: string[] = [];
  for (const text of diffText.split("\n")) {
    if (text.startsWith("diff --git ")) {
      inHunk = false;
    } else if (!inHunk && text.startsWith("@@")) {
      inHunk = true;
    } else if (inHunk && text.startsWith("-")) {
      continue;
    }
    kept.push(text);
  }
  return kept.join("\n");
}

/** One `- <rule>: <file>` line per finding of a gitleaks stdin JSON report,
 * the file mapped from the finding's line in `diffText` (mapDiffLineToFile;
 * the line within the diff means nothing to a reader, so it is not shown)
 * — never the matched text, even redacted (design §13). `null` when
 * `stdout` is not a JSON array. */
export function formatGitleaksReport(
  stdout: string,
  diffText: string,
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const lines = parsed
    .filter(isGitleaksFinding)
    .map(
      (finding) =>
        `- ${finding.RuleID}: ${mapDiffLineToFile(diffText, finding.StartLine) ?? "(unknown file)"}`,
    );
  const unexpected = parsed.length - lines.length;
  if (unexpected > 0)
    lines.push(
      `- (${String(unexpected)} more finding(s) in an unexpected shape)`,
    );
  return lines.join("\n");
}

/**
 * The implement flow's fixed secret scan (工程3 design §3, §14; gitleaks
 * 8.30.1 in the worker image): stages every change, takes the staged diff
 * against `baseSha` (`git diff --cached --text --no-ext-diff --no-textconv
 * -U0`, so `.gitattributes` binary / `-diff` / textconv settings cannot hide
 * content, and the whole branch since its merge-base is scanned every
 * round), drops its removed lines, and pipes it into `gitleaks stdin`
 * running in the private temp dir — nothing in the repository (ignore
 * files, attributes, config) reaches gitleaks. Exit 0 → `ok: true`; exit 1
 * with a complete JSON report → `ok: false` with one line per finding
 * (masked); a diff or report cut by its output cap, exit 1 without JSON, or
 * any other exit (an unknown flag is 126), a timeout — throws, never read
 * as "no leaks".
 */
export async function runGitleaksOnWorktree(
  opts: WorktreeGitOptions & {
    readonly baseSha: string;
    readonly timeoutMs: number;
    readonly createConfigDir?: () => Promise<GitleaksConfigDir>;
  },
): Promise<GitleaksResult> {
  assertSha(opts.baseSha);
  await stageAll(opts);
  const diff = await opts.run(
    buildGitArgv([
      "diff",
      "--cached",
      "--text",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "-U0",
      opts.baseSha,
      "--",
    ]),
    {
      cwd: opts.worktreeDir,
      env: localGitEnv(opts.home, opts.path),
      timeoutMs: opts.timeoutMs,
      maxOutputBytes: GITLEAKS_MAX_DIFF_BYTES,
    },
  );
  if (diff.timedOut)
    throw new Error(
      `git diff --cached timed out after ${String(opts.timeoutMs)}ms`,
    );
  if (diff.exitCode !== 0)
    throw gitError(`git diff --cached failed in ${opts.worktreeDir}`, diff);
  if (isCappedOutput(diff.stdout))
    throw new Error("the staged diff exceeded the scan cap");
  const scanned = dropRemovedDiffLines(diff.stdout);
  const configDir = await (
    opts.createConfigDir ?? defaultCreateGitleaksConfigDir
  )();
  try {
    const result = await opts.run(
      [
        "gitleaks",
        "stdin",
        "--redact",
        "--no-banner",
        "--no-color",
        "--log-level",
        "error",
        "--exit-code",
        String(GITLEAKS_LEAKS_EXIT_CODE),
        "--report-format",
        "json",
        "--report-path",
        "-",
        "--config",
        join(configDir.path, GITLEAKS_CONFIG_FILE),
        "--gitleaks-ignore-path",
        configDir.path,
        "--ignore-gitleaks-allow",
      ],
      {
        cwd: configDir.path,
        env: localGitEnv(opts.home, opts.path),
        stdin: scanned,
        timeoutMs: opts.timeoutMs,
        maxOutputBytes: GITLEAKS_MAX_OUTPUT_BYTES,
      },
    );
    if (result.timedOut)
      throw new Error(`gitleaks timed out after ${String(opts.timeoutMs)}ms`);
    if (result.exitCode === 0) return { ok: true, output: "" };
    if (result.exitCode === GITLEAKS_LEAKS_EXIT_CODE) {
      if (isCappedOutput(result.stdout))
        throw new Error("gitleaks report exceeded the output cap");
      const report = formatGitleaksReport(result.stdout, scanned);
      if (report !== null) {
        return {
          ok: false,
          output: maskSecrets(
            report.length === 0 ? "gitleaks reported a leak" : report,
          ),
        };
      }
    }
    throw new Error(
      maskSecrets(
        `gitleaks failed (exit ${String(result.exitCode)}): ${result.stderr.trim()}`,
      ),
    );
  } finally {
    await configDir.cleanup();
  }
}
