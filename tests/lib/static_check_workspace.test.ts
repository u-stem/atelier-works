// 静的検査の作業木で、重ねるパスと重ねないパスの判定と、その一覧を確かめる。
// 実際の作業木の作成は`static_check_workspace_git.test.ts`が確かめる。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  FORBIDDEN_PATH_PREFIXES,
  IMPLEMENT_PROTECTED_BASENAME_PATTERNS,
  matchesImplementProtectedPath,
} from "../../f/factory/lib/protected_paths.ts";
import {
  isStaticCheckDependencyPath,
  isStaticCheckExecutedPath,
  isStaticCheckGitdirPath,
  isStaticCheckOverlaidPath,
  isStaticCheckUncheckedConfigPath,
  STATIC_CHECK_COMMAND_TIMEOUT_MS,
  STATIC_CHECK_DEPENDENCY_PATHS,
  STATIC_CHECK_MIN_COMMAND_TIMEOUT_MS,
  STATIC_CHECK_NOT_OVERLAID,
  STATIC_CHECK_WORKSPACE_WORST_CASE_SEC,
  staticCheckCommandTimeoutMs,
} from "../../f/factory/lib/static_check_workspace.ts";
import { RUNNER_MAX_STOP_OVERHEAD_MS } from "../../f/factory/lib/workspace.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");

/**
 * 静的検査のコマンドが`bun run`で起動するスクリプトの入口。
 * 設定`static_check_commands_by_repo`の例と、計画が挙げたスクリプトである。
 */
const EXECUTED_ENTRY_SCRIPTS = [
  "scripts/lint-docs.ts",
  "scripts/lint-no-section-sign.ts",
  "scripts/lint-no-short-remote-ref.ts",
  "scripts/check-script-locks.ts",
  "scripts/docs-gen.ts",
] as const;

/** 入口から相対importでたどれるファイルを、リポジトリのルートからの相対パスで返す。 */
function relativeImportClosure(entries: readonly string[]): string[] {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const seen = new Set<string>();
  const pending = entries.map((entry) => join(REPO_ROOT, entry));
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    // 先頭の`#!`の行は、`scanImports`が読めないので外す。
    const source = readFileSync(file, "utf8").replace(/^#!.*/, "");
    for (const found of transpiler.scanImports(source)) {
      if (found.path.startsWith(".")) {
        pending.push(resolve(dirname(file), found.path));
      }
    }
  }
  return [...seen].map((file) => relative(REPO_ROOT, file)).sort();
}

describe("STATIC_CHECK_NOT_OVERLAID", () => {
  test("uses the forbidden path prefixes as the prefixes", () => {
    expect(STATIC_CHECK_NOT_OVERLAID.prefixes).toEqual([
      ...FORBIDDEN_PATH_PREFIXES,
    ]);
  });

  test("treats every file the static check scripts execute as executed", () => {
    const executed = relativeImportClosure(EXECUTED_ENTRY_SCRIPTS);

    const missed = executed.filter((path) => !isStaticCheckExecutedPath(path));

    expect(missed).toEqual([]);
  });

  test("keeps every file the static check scripts execute out of the overlay", () => {
    const executed = relativeImportClosure(EXECUTED_ENTRY_SCRIPTS);

    const overlaid = executed.filter((path) => isStaticCheckOverlaidPath(path));

    expect(overlaid).toEqual([]);
  });

  test("lists the lint scripts by prefix", () => {
    expect(STATIC_CHECK_NOT_OVERLAID.executed.prefixes).toEqual([
      "scripts/lint-",
    ]);
  });

  test("lists the executed scripts that lint-docs imports", () => {
    expect(STATIC_CHECK_NOT_OVERLAID.executed.exactPaths).toEqual([
      "scripts/check-script-locks.ts",
      "scripts/docs-gen.ts",
      "scripts/flow-graph.ts",
      "scripts/launch-graph.ts",
      "scripts/markdown-tree.ts",
      "scripts/ts-tokenize.ts",
      "f/factory/lib/approval_support.ts",
      "f/factory/lib/log.ts",
      "f/factory/lib/prose_check.ts",
      "f/factory/lib/skill_registry.ts",
      "f/factory/lib/types.ts",
    ]);
  });

  test("lists the directory names that are never overlaid at any depth", () => {
    expect(STATIC_CHECK_NOT_OVERLAID.segments).toEqual(["node_modules"]);
  });
});

describe("isStaticCheckOverlaidPath", () => {
  test.each([
    ["f/factory/lib/implement_loop.ts"],
    ["tests/lib/config.test.ts"],
    ["docs/internals/implement.md"],
    ["console/src/lib/configGroups.ts"],
    ["scripts/check-changed.ts"],
    ["rt.d.ts"],
    ["wmill-lock.yaml"],
  ])("overlays the ordinary file %s", (path) => {
    expect(isStaticCheckOverlaidPath(path)).toBe(true);
  });

  test.each([
    ["biome.json"],
    ["biome.jsonc"],
    ["tsconfig.json"],
    ["tsconfig.wmill.json"],
    ["console/tsconfig.json"],
    ["scripts/tsconfig.json"],
    [".markdownlint-cli2.jsonc"],
    [".textlintrc.json"],
    ["lefthook.yml"],
    ["lefthook-local.yml"],
    ["bunfig.toml"],
    ["mise.toml"],
    ["mise.local.toml"],
    [".mise.toml"],
    [".tool-versions"],
    ["wmill.yaml"],
    ["package.json"],
    ["console/package.json"],
    ["f/factory/package.json"],
    ["bun.lock"],
    ["console/bun.lock"],
    [".npmrc"],
    [".gitignore"],
    ["docs/.gitignore"],
    [".ignore"],
    [".editorconfig"],
    [".gitattributes"],
    [".env"],
    ["scripts/.env.local"],
  ])("does not overlay the tool configuration %s", (path) => {
    expect(isStaticCheckOverlaidPath(path)).toBe(false);
  });

  test.each([
    ["scripts/lint-docs.ts"],
    ["scripts/lint-new-rule.ts"],
    ["scripts/lint-risk-register-allowlist.txt"],
    ["scripts/docs-gen.ts"],
    ["f/factory/lib/types.ts"],
  ])("does not overlay the executed script %s", (path) => {
    expect(isStaticCheckOverlaidPath(path)).toBe(false);
  });

  test.each([
    [".github/workflows/ci.yml"],
    [".claude/settings.json"],
    ["mise/config.toml"],
    ["scripts/claude-hooks/run.ts"],
  ])("does not overlay the forbidden path %s", (path) => {
    expect(isStaticCheckOverlaidPath(path)).toBe(false);
  });

  test.each([
    ["node_modules/typescript/lib/tsc.js"],
    ["console/node_modules/vite/index.js"],
  ])("does not overlay the dependency directory file %s", (path) => {
    expect(isStaticCheckOverlaidPath(path)).toBe(false);
  });

  test.each([
    ["Biome.json"],
    ["NODE_MODULES/typescript/lib/tsc.js"],
    ["Scripts/Lint-docs.ts"],
    [".GitHub/workflows/ci.yml"],
  ])("matches %s regardless of case", (path) => {
    expect(isStaticCheckOverlaidPath(path)).toBe(false);
  });
});

describe("STATIC_CHECK_DEPENDENCY_PATHS", () => {
  test("lists the manifests and lockfiles the checks install from", () => {
    expect(STATIC_CHECK_DEPENDENCY_PATHS).toEqual([
      "package.json",
      "bun.lock",
      "console/package.json",
      "console/bun.lock",
    ]);
  });
});

describe("isStaticCheckDependencyPath", () => {
  test.each([
    ["package.json", true],
    ["bun.lock", true],
    ["console/package.json", true],
    ["console/bun.lock", true],
    ["Package.json", true],
    ["f/factory/steps/implement_verify.script.lock", false],
    ["f/factory/package.json", false],
    ["package.json.bak", false],
  ])("treats %s as a dependency file: %p", (path, expected) => {
    expect(isStaticCheckDependencyPath(path)).toBe(expected);
  });
});

describe("isStaticCheckExecutedPath", () => {
  test.each([
    ["scripts/lint-docs.ts", true],
    ["scripts/lint-new-rule.ts", true],
    ["scripts/lint-risk-register-allowlist.txt", true],
    ["scripts/docs-gen.ts", true],
    ["scripts/ts-tokenize.ts", true],
    ["f/factory/lib/types.ts", true],
    ["F/Factory/Lib/Types.ts", true],
    ["f/factory/lib/implement_loop.ts", false],
    ["scripts/check-changed.ts", false],
    ["scripts/lint", false],
    ["biome.json", false],
    [".github/workflows/ci.yml", false],
  ])("treats %s as executed by the checks: %p", (path, expected) => {
    expect(isStaticCheckExecutedPath(path)).toBe(expected);
  });
});

describe("staticCheckCommandTimeoutMs", () => {
  test("shares one check command between the install and the commands", () => {
    expect(staticCheckCommandTimeoutMs(900_000, 15_000, 6)).toBe(115_714);
  });

  // 依存の導入と6件のコマンドが、すべて打ち切りまでかかり、停止の上乗せを足しても、検査コマンド1件分に収まる。
  test("keeps the worst case of the install and the commands within one check command", () => {
    const share = staticCheckCommandTimeoutMs(900_000, 15_000, 6) ?? 0;
    expect(7 * (share + 15_000)).toBeLessThanOrEqual(900_000 + 15_000);
  });

  test("returns the floor of thirty seconds when the share just reaches it", () => {
    expect(staticCheckCommandTimeoutMs(75_000, 15_000, 1)).toBe(
      STATIC_CHECK_MIN_COMMAND_TIMEOUT_MS,
    );
  });

  test("returns null when the share falls below thirty seconds", () => {
    expect(staticCheckCommandTimeoutMs(74_999, 15_000, 1)).toBeNull();
  });

  test("sets the floor to thirty seconds", () => {
    expect(STATIC_CHECK_MIN_COMMAND_TIMEOUT_MS).toBe(30_000);
  });
});

describe("STATIC_CHECK_WORKSPACE_WORST_CASE_SEC", () => {
  test("covers git archive, tar, git init, and git add at their timeout with the runner's stop overhead", () => {
    expect(STATIC_CHECK_WORKSPACE_WORST_CASE_SEC * 1000).toBeGreaterThanOrEqual(
      4 * (STATIC_CHECK_COMMAND_TIMEOUT_MS + RUNNER_MAX_STOP_OVERHEAD_MS),
    );
  });
});

describe("isStaticCheckGitdirPath", () => {
  test.each([
    ["HEAD"],
    ["config"],
    ["objects/ab/cdef"],
    ["refs/heads/main"],
    ["packed-refs"],
    ["commondir"],
    ["gitdir"],
    ["index"],
    ["info/exclude"],
    ["hooks/pre-commit"],
    ["worktrees/w/HEAD"],
    ["modules/m/config"],
    ["Config"],
    ["OBJECTS/ab/cdef"],
    [".GIT"],
    [".git."],
    [".git /config"],
  ])("treats the top-level %s as shaping a git directory", (path) => {
    expect(isStaticCheckGitdirPath(path)).toBe(true);
  });

  test.each([
    ["src/config/a.ts"],
    ["configs/a.ts"],
    ["docs/HEAD.md"],
    ["index.ts"],
    ["information.md"],
    [".gitignore"],
    [".gitattributes"],
    [".github/workflows/ci.yml"],
    ["f/factory/lib/config.ts"],
  ])("does not treat %s as shaping a git directory", (path) => {
    expect(isStaticCheckGitdirPath(path)).toBe(false);
  });
});

describe("isStaticCheckUncheckedConfigPath", () => {
  test.each([
    ["eslint.config.js"],
    ["console/vite.config.ts"],
    ["vitest.config.mts"],
    [".eslintrc.json"],
    [".babelrc"],
    [".prettierrc.yaml"],
    ["deno.jsonc"],
    ["Makefile"],
    ["Taskfile.yml"],
    ["turbo.json"],
    [".pre-commit-config.yaml"],
    [".pnpmfile.cjs"],
    [".yarnrc.yml"],
    ["yarn.lock"],
    ["pyproject.toml"],
    [".gitmodules"],
    ["wmill.yml"],
    [".nvmrc"],
    [".gitleaks.toml"],
    ["sub/ESLint.Config.JS"],
  ])("treats %s as a tool configuration the checks do not pin", (path) => {
    expect(isStaticCheckUncheckedConfigPath(path)).toBe(true);
  });

  test.each([
    ["biome.json"],
    ["tsconfig.json"],
    ["package.json"],
    ["wmill.yaml"],
    ["CODEOWNERS"],
    ["f/factory/lib/config.ts"],
    ["tests/lib/config.test.ts"],
    ["docs/internals/implement.md"],
    [".claude/skills/pr-body/SKILL.md"],
  ])(
    "does not treat %s as a tool configuration the checks do not pin",
    (path) => {
      expect(isStaticCheckUncheckedConfigPath(path)).toBe(false);
    },
  );
});

/** 静的検査がPRの版をどう扱うかを、判定の関数から求める。 */
function staticCheckHandling(path: string): "skipped" | "base" | "overlaid" {
  if (isStaticCheckUncheckedConfigPath(path)) return "skipped";
  return isStaticCheckOverlaidPath(path) ? "overlaid" : "base";
}

/**
 * 実装フローの保護パスのファイル名の規則ごとに、当たるファイル名の例と、静的検査での扱い。
 * `skipped`は静的検査を飛ばす、`base`は基準の版を使う、`overlaid`はPRの版を重ねる(道具の設定として読まれないもの)。
 */
const IMPLEMENT_BASENAME_HANDLING: Readonly<
  Record<string, readonly [string, "skipped" | "base" | "overlaid"]>
> = {
  "^wmill\\.ya?ml$": ["wmill.yml", "skipped"],
  "^mise\\.toml$": ["mise.toml", "base"],
  "^mise\\..*\\.toml$": ["mise.local.toml", "base"],
  "^\\.mise\\.toml$": [".mise.toml", "base"],
  "^lefthook\\.yml$": ["lefthook.yml", "base"],
  "^lefthook-local\\.yml$": ["lefthook-local.yml", "base"],
  "^lefthook\\.toml$": ["lefthook.toml", "base"],
  "^lefthook\\.json$": ["lefthook.json", "base"],
  "^bunfig\\.toml$": ["bunfig.toml", "base"],
  "^\\.npmrc$": [".npmrc", "base"],
  "^\\.gitattributes$": [".gitattributes", "base"],
  "^\\.gitmodules$": [".gitmodules", "skipped"],
  "^\\.markdownlint(-cli2)?\\.(jsonc?|ya?ml|[cm]?js)$": [
    ".markdownlint.cjs",
    "base",
  ],
  "^\\.textlintrc(\\..*)?$": [".textlintrc.js", "base"],
  "^\\.tool-versions$": [".tool-versions", "base"],
  "^\\.env(\\..*)?$": [".env.local", "base"],
  "^\\.(node|bun)-version$": [".node-version", "skipped"],
  "^\\.?biome\\.jsonc?$": ["biome.jsonc", "base"],
  "^\\.gitignore$": [".gitignore", "base"],
  "^\\.ignore$": [".ignore", "base"],
  "^\\.gitleaks(ignore|\\.toml)$": [".gitleaksignore", "skipped"],
  "^\\.python-version$": [".python-version", "skipped"],
  "^\\.nvmrc$": [".nvmrc", "skipped"],
  "^rust-toolchain(\\.toml)?$": ["rust-toolchain.toml", "skipped"],
  "^\\.yarnrc(\\.yml)?$": [".yarnrc", "skipped"],
  "^\\.pnpmfile\\.cjs$": [".pnpmfile.cjs", "skipped"],
  "^(bun\\.lockb?|package-lock\\.json|npm-shrinkwrap\\.json|pnpm-lock\\.yaml|yarn\\.lock)$":
    ["pnpm-lock.yaml", "skipped"],
  "^[\\w.-]+\\.config\\.[cm]?[jt]s$": ["eslint.config.mjs", "skipped"],
  "^\\.(eslintrc|babelrc|prettierrc)(\\..*)?$": [".prettierrc", "skipped"],
  "^(Makefile|[Jj]ustfile|Taskfile\\.ya?ml|turbo\\.json|nx\\.json|deno\\.jsonc?|CODEOWNERS|\\.pre-commit-config\\.yaml)$":
    ["justfile", "skipped"],
  "^package\\.json$": ["package.json", "base"],
  "^(uv|poetry)\\.lock$": ["uv.lock", "skipped"],
  "^Pipfile(\\.lock)?$": ["Pipfile.lock", "skipped"],
  "^pyproject\\.toml$": ["pyproject.toml", "skipped"],
  "^setup\\.(py|cfg)$": ["setup.py", "skipped"],
  "^requirements.*\\.txt$": ["requirements-dev.txt", "skipped"],
  "^Cargo\\.(lock|toml)$": ["Cargo.toml", "skipped"],
  "^go\\.(sum|mod)$": ["go.mod", "skipped"],
  "^Gemfile(\\.lock)?$": ["Gemfile", "skipped"],
  "^composer\\.(lock|json)$": ["composer.json", "skipped"],
};

describe("static check handling of the implement protected file names", () => {
  test("decides the handling of every implement protected file name pattern", () => {
    expect(
      IMPLEMENT_PROTECTED_BASENAME_PATTERNS.map((pattern) => pattern.source),
    ).toEqual(Object.keys(IMPLEMENT_BASENAME_HANDLING));
  });

  test.each(
    Object.entries(IMPLEMENT_BASENAME_HANDLING).map(
      ([source, [sample, handling]]) => [source, sample, handling] as const,
    ),
  )("handles a file matching %s (%s) as %s", (_source, sample, handling) => {
    expect([
      matchesImplementProtectedPath(sample),
      staticCheckHandling(sample),
    ]).toEqual([true, handling]);
  });

  test("overlays CODEOWNERS, which no tool reads as a configuration", () => {
    expect(staticCheckHandling("CODEOWNERS")).toBe("overlaid");
  });
});
