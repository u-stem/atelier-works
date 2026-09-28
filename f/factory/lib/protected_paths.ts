// Protected-path classification shared by pr_fix (steps/pr_workflow_support.ts,
// where a match blocks the push — docs/security.md "pr_fix の安全策") and the
// implement flow (lib/implement_support.ts, where a match is only recorded
// for the PR body and the Discord notification — 工程3 design §3). Lives in
// lib so implement_support never imports from steps; pr_workflow_support.ts
// re-exports everything here, so its existing callers and tests are
// unchanged. The two prefix lists differ on purpose: `infra/**` only joins
// the implement list (the pr_fix list is deliberately not widened).

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

/** The implement flow's prefix list: pr_fix's plus `infra/**` (worker image
 * and compose definitions — changing them needs a host-side `mise run
 * deploy`, so a reviewer must know). pr_fix's own list is unchanged. */
export const IMPLEMENT_PROTECTED_PATH_PREFIXES: readonly string[] = [
  ...FORBIDDEN_PATH_PREFIXES,
  "infra/",
];

/** docs/security.md "変更してはいけないファイル". Directory entries in
 * `prefixes` match by repo-root-relative path prefix (the bare directory
 * name itself also matches); `FORBIDDEN_BASENAME_PATTERNS` match by
 * basename regardless of directory. `prefixes` defaults to pr_fix's list;
 * the implement flow passes `IMPLEMENT_PROTECTED_PATH_PREFIXES`. */
export function matchesForbiddenPath(
  path: string,
  prefixes: readonly string[] = FORBIDDEN_PATH_PREFIXES,
): boolean {
  const normalized = path.replace(/^\.\//, "");
  for (const prefix of prefixes) {
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
