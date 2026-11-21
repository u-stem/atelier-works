// 静的検査の作業木で、重ねるパスと重ねないパスの判定と、その一覧を確かめる。
// 実際の作業木の作成は`static_check_workspace_git.test.ts`が確かめる。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { FORBIDDEN_PATH_PREFIXES } from "../../f/factory/lib/protected_paths.ts";
import {
  isStaticCheckDependencyPath,
  isStaticCheckOverlaidPath,
  STATIC_CHECK_DEPENDENCY_PATHS,
  STATIC_CHECK_NOT_OVERLAID,
} from "../../f/factory/lib/static_check_workspace.ts";

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
  test("includes every forbidden path prefix", () => {
    expect(STATIC_CHECK_NOT_OVERLAID.prefixes).toEqual(
      expect.arrayContaining([...FORBIDDEN_PATH_PREFIXES]),
    );
  });

  test("keeps every file the static check scripts execute out of the overlay", () => {
    const executed = relativeImportClosure(EXECUTED_ENTRY_SCRIPTS);

    const overlaid = executed.filter((path) => isStaticCheckOverlaidPath(path));

    expect(overlaid).toEqual([]);
  });

  test("lists the executed scripts that lint-docs imports", () => {
    expect(STATIC_CHECK_NOT_OVERLAID.exactPaths).toEqual([
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
  test("lists the manifests and lockfiles the workspace installs from", () => {
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
