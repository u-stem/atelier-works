// Pure decision/formatting logic for self_update.ts (plan §4 "self_update",
// §4b). No I/O — see that script for wiring (git/wmill CLI subprocesses,
// Data Table recording, Discord notification).

// ---------------------------------------------------------------------------
// decideUpdate: whether a redeploy is needed at all
// ---------------------------------------------------------------------------

export type UpdateDecision =
  | { readonly outcome: "unchanged" }
  | { readonly outcome: "update" };

/**
 * Compares the self clone's current HEAD sha against the last sha recorded
 * in the `f/factory/deployed_sha` Windmill variable. An empty `deployedSha`
 * (the variable's initial value, before its first successful deploy) always
 * counts as "different", so the very first run always deploys.
 */
export function decideUpdate(
  currentSha: string,
  deployedSha: string,
): UpdateDecision {
  return currentSha === deployedSha
    ? { outcome: "unchanged" }
    : { outcome: "update" };
}

// ---------------------------------------------------------------------------
// assertBranchMatches: defense-in-depth check on ensureFactoryClone's own
// postcondition
// ---------------------------------------------------------------------------

/**
 * Throws unless `actualBranch` equals `expectedBranch` — a defense-in-depth
 * check (M7 re-gate) that `ensureFactoryClone` actually left the self clone
 * on `config.factory_branch`, since a real worker run once found it stuck
 * on `main` before `ensureFactoryClone`'s own re-checkout fix (see
 * lib/workspace.ts's `ensureFactoryClone` module comment for the full
 * incident: a plain `git pull --ff-only` only ever advances whatever branch
 * was already checked out, never switches to or verifies the configured
 * one). `dir` is only used to make the thrown message actionable.
 */
export function assertBranchMatches(
  actualBranch: string,
  expectedBranch: string,
  dir: string,
): void {
  if (actualBranch !== expectedBranch) {
    throw new Error(
      `self_update: self clone at ${dir} is on branch "${actualBranch}", expected factory_branch "${expectedBranch}"`,
    );
  }
}

// ---------------------------------------------------------------------------
// classifyChangedPaths: which changed paths need a host-side `mise run deploy`
// ---------------------------------------------------------------------------

/**
 * Paths whose changes worker-side `wmill sync push` / `wmill datatable
 * migrate up` cannot themselves apply — they require a host-side `mise run
 * deploy` (worker image rebuild, compose restart) to take effect. Only the
 * worker image / compose definition (`infra/**`) qualifies unconditionally.
 * `mise.toml` qualifies only when its `[tools]` (tool versions) or `[env]`
 * (values compose reads) sections changed — a task definition edit does
 * not affect the running worker (see `miseTomlNeedsHostAction`).
 * `scripts/**` (host-side dev tooling) and `mise.local.toml.example` (a
 * human-facing template) never affect the running worker.
 */
const HOST_ACTION_PATH_PATTERNS: readonly RegExp[] = [/^infra\//];

export const MISE_TOML_PATH = "mise.toml";

/** Sections of mise.toml whose content the running stack depends on:
 * `[tools]` pins the versions (e.g. the worker image's tool versions) and
 * `[env]` holds the values docker compose interpolates. */
const MISE_HOST_SECTIONS: readonly string[] = ["tools", "env"];

/**
 * Extracts the text of the host-relevant sections (`[tools]`, `[env]`) of
 * a mise.toml (pure, for testing): line-based, a `[name]` header starts a
 * section and the next header ends it; blank lines and `#` comments are
 * dropped so a comment-only edit does not count.
 */
export function extractMiseHostSections(toml: string): string {
  const kept: string[] = [];
  let current: string | null = null;
  for (const rawLine of toml.split("\n")) {
    const line = rawLine.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header !== null) {
      current = header[1] ?? null;
      continue;
    }
    if (current === null || !MISE_HOST_SECTIONS.includes(current)) continue;
    if (line.length === 0 || line.startsWith("#")) continue;
    kept.push(`${current}:${line}`);
  }
  return kept.join("\n");
}

/** Whether a mise.toml change needs a host-side `mise run deploy` (pure,
 * for testing): true only when the `[tools]` / `[env]` sections differ
 * between the two versions. `oldToml === null` (no prior deploy to diff
 * against) is treated conservatively as needing host action. */
export function miseTomlNeedsHostAction(
  oldToml: string | null,
  newToml: string,
): boolean {
  if (oldToml === null) return true;
  return extractMiseHostSections(oldToml) !== extractMiseHostSections(newToml);
}

export type ChangedPathsClassification = {
  readonly needs_host_action: boolean;
  readonly host_paths: string[];
};

/**
 * Classifies a list of changed file paths (as reported by `git diff
 * --name-only` / `git ls-tree --name-only`): `host_paths` is the subset
 * that requires a host-side deploy, and `needs_host_action` is whether that
 * subset is non-empty. `miseTomlHostSectionsChanged` is the caller's
 * verdict for mise.toml (from `miseTomlNeedsHostAction`); it only matters
 * when mise.toml is among `paths`.
 */
export function classifyChangedPaths(
  paths: readonly string[],
  miseTomlHostSectionsChanged: boolean,
): ChangedPathsClassification {
  const hostPaths = paths.filter(
    (path) =>
      HOST_ACTION_PATH_PATTERNS.some((pattern) => pattern.test(path)) ||
      (path === MISE_TOML_PATH && miseTomlHostSectionsChanged),
  );
  return { needs_host_action: hostPaths.length > 0, host_paths: hostPaths };
}

// ---------------------------------------------------------------------------
// wmill CLI connection: workspace/base-url/token, as argv flags
// ---------------------------------------------------------------------------
//
// External contract, measured directly against a live Windmill CE 1.817.0
// instance from a *blank* `WMILL_CONFIG_DIR` (2026-09-26) — the state every
// worker container starts in, having never run `wmill workspace add`. This
// replaces an earlier, unverified assumption that `WM_WORKSPACE` /
// `WM_BASE_URL` / `WM_TOKEN` env vars alone would let `wmill sync push` /
// `wmill datatable migrate up` run non-interactively; a real run against
// the worker failed with "No workspace given and no default set" using
// that approach. Measured behavior of `wmill sync push --dry-run` (same
// for `wmill datatable migrate up`) with `WMILL_CONFIG_DIR` pointed at an
// empty directory:
//   - `WM_WORKSPACE=<name>` alone IS recognized (as a `--workspace` alias:
//     "Using workspace override: <name> (selected via --workspace)"), but
//     still requires a locally *stored* profile matching that workspace —
//     which does not exist in a blank config dir, so it still fails with
//     "No workspace profile found for branch '<name>' ... Not a TTY,
//     cannot create profile interactively."
//   - `WM_BASE_URL` and `WM_TOKEN` have **no effect at all** — set alone or
//     together with `WM_WORKSPACE`, the CLI still tries to find a stored
//     profile and fails the same way.
//   - Only passing all three as *flags* together —
//     `--workspace <ws> --base-url <url> --token <token>` — makes the CLI
//     skip the "look for a stored profile" path entirely (this matches
//     `wmill sync push --help`'s own text: "If used [--base-url], --token
//     and --workspace are required and no local remote/workspace already
//     set will be used"). Confirmed end to end: a dummy token reaches
//     "Could not authenticate ... Unauthorized" (proving workspace/base-url
//     resolution succeeded), and the real `f/factory/wmill_token` value
//     reaches a normal "0 changes to apply" / "No pending migrations to
//     run" result for `sync push --dry-run` / `datatable migrate up`
//     respectively.
// Consequence: the token cannot go through env here (there is no env var
// this CLI actually reads for it) — it must be a literal argv element,
// the same accepted exception scripts/bootstrap.sh's module doc documents
// for `wmill workspace add --token` (its only other way to receive a
// token non-interactively).

export type WmillCliContextInput = {
  readonly BASE_INTERNAL_URL?: string | undefined;
  readonly BASE_URL?: string | undefined;
  readonly WM_WORKSPACE?: string | undefined;
};

export type WmillCliContext = {
  readonly workspace: string;
  readonly baseUrl: string;
};

/**
 * Resolves the `--workspace`/`--base-url` values from the job's own
 * ambient Windmill-provided env (never from a caller-supplied argument —
 * these describe *this* job's own workspace, not something a caller picks).
 * `baseUrl` prefers `BASE_INTERNAL_URL`, falling back to `BASE_URL` (same
 * fallback order the former suspend-based approval_decide.ts once used for
 * its own internal-URL resolution, for the same reason: measured directly
 * inside a worker job, `BASE_INTERNAL_URL`
 * is unset there while `BASE_URL` is set — observed value
 * `http://127.0.0.1:45753/`, a worker-local proxy port, not the host-facing
 * `WM_BASE_URL` `mise.toml` sets for host-side dev use. Confirmed reachable
 * end to end: `wmill datatable migrate up` succeeded through it in a real
 * worker run). Throws if either is unresolvable — a worker script must
 * fail loudly here with a clear message, rather than let the `wmill` CLI
 * itself fail with a more confusing "no workspace"/"could not authenticate"
 * error two layers down.
 */
export function resolveWmillCliContext(
  env: WmillCliContextInput,
): WmillCliContext {
  const baseUrl = env.BASE_INTERNAL_URL ?? env.BASE_URL;
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new Error(
      "self_update: cannot resolve a base URL for the wmill CLI (BASE_INTERNAL_URL and BASE_URL are both unset)",
    );
  }
  const workspace = env.WM_WORKSPACE;
  if (workspace === undefined || workspace.length === 0) {
    throw new Error(
      "self_update: cannot resolve a workspace for the wmill CLI (WM_WORKSPACE is unset)",
    );
  }
  return { workspace, baseUrl };
}

/**
 * Appends the `--workspace <ws> --base-url <url> --token <token>` flags
 * `wmill` requires to run non-interactively from a blank config dir (see
 * this section's module comment for the measured contract). `token` is
 * always the caller's own, separately-fetched secret — never read from
 * `context`, so it can never be accidentally omitted by a missing/
 * misnamed field.
 */
export function buildWmillArgv(
  baseArgv: readonly string[],
  context: WmillCliContext,
  token: string,
): string[] {
  return [
    ...baseArgv,
    "--workspace",
    context.workspace,
    "--base-url",
    context.baseUrl,
    "--token",
    token,
  ];
}

// ---------------------------------------------------------------------------
// buildWmillEnv: minimal env for the worker-local `wmill` CLI subprocess
// ---------------------------------------------------------------------------

export type WmillEnvInput = {
  readonly HOME?: string | undefined;
  readonly PATH?: string | undefined;
};

/**
 * Builds the minimal env for the `wmill sync push` / `wmill datatable
 * migrate up` subprocess: only `HOME`/`PATH` (needed for the CLI's own
 * config dir and to locate the `wmill` binary via PATH search) — never the
 * full ambient `process.env`, so nothing else the worker process happens to
 * carry leaks into this subprocess's environment. Workspace/base-url/token
 * are deliberately *not* env vars here — see `buildWmillArgv`'s module
 * comment for why (measured: this CLI does not read them from env at all).
 */
export function buildWmillEnv(env: WmillEnvInput): Record<string, string> {
  const result: Record<string, string> = {};
  if (env.HOME !== undefined) result.HOME = env.HOME;
  if (env.PATH !== undefined) result.PATH = env.PATH;
  return result;
}

// ---------------------------------------------------------------------------
// truncateOutput: cap a subprocess's stdout/stderr before logging it
// ---------------------------------------------------------------------------

/** Truncates `text` to at most `max` characters, for logging a subprocess's
 * (already `maskSecrets`-masked) stdout/stderr without an unbounded job log. */
export function truncateOutput(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

// ---------------------------------------------------------------------------
// Raw app dependencies: `wmill sync push` bundles the Console raw app in
// place and resolves its imports from node_modules inside the self clone.
// ---------------------------------------------------------------------------

/** Repo-relative directory of the Console raw app whose npm dependencies
 * must be installed before `wmill sync push` can bundle it. */
export const RAW_APP_RELATIVE_DIR = "f/factory/factory_console__raw_app";

/**
 * `npm ci` argv for the raw app (pure, for testing): installs exactly what
 * package-lock.json pins, never rewriting it — a plain `npm install` inside
 * the self clone is what once left package-lock.json modified and blocked
 * the next `git checkout -B`. `--no-audit --no-fund` keeps the run quiet
 * and offline-friendly.
 */
export function buildNpmCiArgv(rawAppDir: string): string[] {
  return ["npm", "ci", "--prefix", rawAppDir, "--no-audit", "--no-fund"];
}
