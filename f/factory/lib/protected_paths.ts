// Protected-path classification shared by pr_fix (steps/pr_workflow_support.ts,
// where a match blocks the push — docs/security.md "pr_fix の安全策") and the
// implement flow (lib/implement_support.ts, where a match is only recorded
// for the PR body and the Discord notification — 工程3 design §3). Lives in
// lib so implement_support never imports from steps; pr_workflow_support.ts
// re-exports everything here, so its existing callers and tests are
// unchanged. The two lists differ on purpose: the implement flow runs check
// commands against Claude's changes, so everything that decides what those
// commands execute (hooks, package-manager and tool configuration,
// lockfiles, any package.json) is protected there; the pr_fix lists are
// deliberately not widened.

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

// Covers every config surface that changes which commands run or what a
// package manager / git trusts: agent settings, CI workflows, mise's XDG /
// dotfile config locations, and lefthook's directory form.
export const FORBIDDEN_PATH_PREFIXES: readonly string[] = [
  ".claude/",
  ".agents/",
  ".github/workflows/",
  ".mise/",
  ".config/mise/",
  ".lefthook/",
];

export const FORBIDDEN_BASENAME_PATTERNS: readonly RegExp[] = [
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

/** The implement flow's prefix list: pr_fix's with `.github/workflows/`
 * widened to all of `.github/` (actions, dependabot, CODEOWNERS), plus
 * `infra/**` (worker image and compose definitions — changing them needs a
 * host-side `mise run deploy`, so a reviewer must know), git hook
 * directories (`.husky/`, `.githooks/`), `.yarn/` (plugins and releases the
 * package manager executes) and `.devcontainer/`. pr_fix's own list is
 * unchanged. */
export const IMPLEMENT_PROTECTED_PATH_PREFIXES: readonly string[] = [
  ...FORBIDDEN_PATH_PREFIXES.map((prefix) =>
    prefix === ".github/workflows/" ? ".github/" : prefix,
  ),
  "infra/",
  ".husky/",
  ".githooks/",
  ".yarn/",
  ".devcontainer/",
];

/** The implement flow's basename list: pr_fix's plus every file that
 * decides what a check command executes or trusts — env files, the
 * gitleaks configuration, runtime/toolchain pins, package-manager
 * configuration and lockfiles, tool config modules and rc files, task
 * runners, and any package.json (not only its `scripts`). pr_fix's own list
 * is unchanged. */
export const IMPLEMENT_PROTECTED_BASENAME_PATTERNS: readonly RegExp[] = [
  ...FORBIDDEN_BASENAME_PATTERNS,
  /^\.env(\..*)?$/,
  /^\.gitleaks(ignore|\.toml)$/,
  /^\.tool-versions$/,
  /^\.(node|bun|python)-version$/,
  /^\.nvmrc$/,
  /^rust-toolchain(\.toml)?$/,
  /^\.yarnrc(\.yml)?$/,
  /^\.pnpmfile\.cjs$/,
  /^(bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/,
  /^[\w.-]+\.config\.[cm]?[jt]s$/,
  /^\.(eslintrc|babelrc|prettierrc)(\..*)?$/,
  /^(Makefile|[Jj]ustfile|Taskfile\.ya?ml|turbo\.json|nx\.json|deno\.jsonc?|CODEOWNERS|\.pre-commit-config\.yaml)$/,
  /^package\.json$/,
];

function matchesPathLists(
  path: string,
  prefixes: readonly string[],
  basenamePatterns: readonly RegExp[],
): boolean {
  const normalized = path.replace(/^\.\//, "");
  for (const prefix of prefixes) {
    if (normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)) {
      return true;
    }
  }
  const basename = normalized.split("/").pop() ?? normalized;
  return basenamePatterns.some((pattern) => pattern.test(basename));
}

/** docs/security.md "変更してはいけないファイル". Directory entries in
 * `prefixes` match by repo-root-relative path prefix (the bare directory
 * name itself also matches); `FORBIDDEN_BASENAME_PATTERNS` match by
 * basename regardless of directory. `prefixes` defaults to pr_fix's list. */
export function matchesForbiddenPath(
  path: string,
  prefixes: readonly string[] = FORBIDDEN_PATH_PREFIXES,
): boolean {
  return matchesPathLists(path, prefixes, FORBIDDEN_BASENAME_PATTERNS);
}

/** The implement flow's protected-path check: same matching rules as
 * matchesForbiddenPath, with IMPLEMENT_PROTECTED_PATH_PREFIXES and
 * IMPLEMENT_PROTECTED_BASENAME_PATTERNS. */
export function matchesImplementProtectedPath(path: string): boolean {
  return matchesPathLists(
    path,
    IMPLEMENT_PROTECTED_PATH_PREFIXES,
    IMPLEMENT_PROTECTED_BASENAME_PATTERNS,
  );
}

export function isNewShellScript(entry: ChangedPath): boolean {
  return entry.status === "added" && /\.sh$/i.test(entry.path);
}
