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
 * in the `f/factory/deployed_sha` Windmill variable. An empty
 * `deployedSha` (the variable's initial value, or a value reset back to
 * that by an unrelated `wmill sync push` — see self_update.ts's module
 * comment) always counts as "different", so the very first (or a re-synced)
 * run always deploys.
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
// classifyChangedPaths: which changed paths need a host-side `mise run deploy`
// ---------------------------------------------------------------------------

/**
 * Paths whose changes worker-side `wmill sync push` / `wmill datatable
 * migrate up` cannot themselves apply — they require a host-side `mise run
 * deploy` (worker image rebuild, compose restart) to take effect.
 */
const HOST_ACTION_PATH_PATTERNS: readonly RegExp[] = [
  /^infra\//,
  /^mise\.toml$/,
  /^mise\.local\.toml\.example$/,
  /^scripts\//,
];

export type ChangedPathsClassification = {
  readonly needs_host_action: boolean;
  readonly host_paths: string[];
};

/**
 * Classifies a list of changed file paths (as reported by `git diff
 * --name-only` / `git ls-tree --name-only`): `host_paths` is the subset
 * that matches one of `HOST_ACTION_PATH_PATTERNS`, and `needs_host_action`
 * is whether that subset is non-empty.
 */
export function classifyChangedPaths(
  paths: readonly string[],
): ChangedPathsClassification {
  const hostPaths = paths.filter((path) =>
    HOST_ACTION_PATH_PATTERNS.some((pattern) => pattern.test(path)),
  );
  return { needs_host_action: hostPaths.length > 0, host_paths: hostPaths };
}

// ---------------------------------------------------------------------------
// buildWmillEnv: minimal env for the worker-local `wmill` CLI subprocess
// ---------------------------------------------------------------------------

export type WmillEnvInput = {
  readonly BASE_INTERNAL_URL?: string | undefined;
  readonly BASE_URL?: string | undefined;
  readonly WM_WORKSPACE?: string | undefined;
  readonly HOME?: string | undefined;
  readonly PATH?: string | undefined;
};

/**
 * Builds the minimal env for the `wmill sync push` / `wmill datatable
 * migrate up` subprocess: only `WM_BASE_URL` / `WM_TOKEN` / `WM_WORKSPACE`
 * (plus `HOME`/`PATH`, needed for the CLI's own config dir and to locate
 * the `wmill` binary via PATH search) — never the full ambient `process.env`,
 * so nothing else the worker process happens to carry leaks into this
 * subprocess's environment. `WM_BASE_URL` prefers `BASE_INTERNAL_URL`,
 * falling back to `BASE_URL` (same fallback order as
 * approval_decide.ts's `resolveInternalBase`, and for the same reason:
 * measured directly inside a worker job, `BASE_INTERNAL_URL` is unset there
 * while `BASE_URL` is set). `token` (the `f/factory/wmill_token` variable's
 * value) is never read from `env` — it is always the caller's own,
 * separately-fetched secret, so it can never be accidentally omitted by a
 * missing/misnamed env field.
 */
export function buildWmillEnv(
  env: WmillEnvInput,
  token: string,
): Record<string, string> {
  const result: Record<string, string> = { WM_TOKEN: token };
  const baseUrl = env.BASE_INTERNAL_URL ?? env.BASE_URL;
  if (baseUrl !== undefined) result.WM_BASE_URL = baseUrl;
  if (env.WM_WORKSPACE !== undefined) result.WM_WORKSPACE = env.WM_WORKSPACE;
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
