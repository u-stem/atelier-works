import { describe, expect, test } from "bun:test";
import { dirname, join, normalize } from "node:path";
import {
  type CiFixChange,
  type CiFixViolationCode,
  checkCiFixChanges,
  isDeniedPath,
  isTestPath,
  weakensChecks,
} from "../../f/factory/lib/ci_fix_paths.ts";

const change = (
  path: string,
  overrides: Partial<CiFixChange> = {},
): CiFixChange => ({
  path,
  status: "modified",
  mode: "100644",
  addedLines: ["const x = 1;"],
  removedLineCount: 1,
  ...overrides,
});

/** 違反が1件だけのときの理由。無い、または複数ならnull。 */
function codeOf(
  changes: readonly CiFixChange[],
  prChangedPaths: readonly string[] = [],
): CiFixViolationCode | null {
  const verdict = checkCiFixChanges({ changes, prChangedPaths });
  if (verdict.ok || verdict.violations.length !== 1) return null;
  return verdict.violations[0]?.code ?? null;
}

const allowed = (path: string, overrides: Partial<CiFixChange> = {}) =>
  checkCiFixChanges({
    changes: [change(path, overrides)],
    prChangedPaths: [path],
  }).ok;

describe("allow list", () => {
  test("allows a file the pull request already changed", () => {
    expect(allowed("f/factory/lib/feature.ts")).toBe(true);
  });

  test("allows a deletion of a file the pull request already changed", () => {
    expect(
      allowed("f/factory/lib/feature.ts", {
        status: "deleted",
        addedLines: [],
      }),
    ).toBe(true);
  });

  test("allows no changes at all", () => {
    expect(
      checkCiFixChanges({ changes: [], prChangedPaths: ["a.ts"] }).ok,
    ).toBe(true);
  });

  test("rejects a file the pull request did not change", () => {
    expect(
      codeOf([change("f/factory/lib/other.ts")], ["f/factory/lib/feature.ts"]),
    ).toBe("not_in_pull_request");
  });

  test("rejects a new non-test file", () => {
    expect(
      codeOf([
        change("f/factory/lib/new.ts", {
          status: "added",
          removedLineCount: 0,
        }),
      ]),
    ).toBe("not_in_pull_request");
  });

  test("allows a new test file", () => {
    expect(
      checkCiFixChanges({
        changes: [
          change("tests/lib/new.test.ts", {
            status: "added",
            removedLineCount: 0,
          }),
        ],
        prChangedPaths: [],
      }).ok,
    ).toBe(true);
  });

  test("allows a new test file next to the source", () => {
    expect(
      checkCiFixChanges({
        changes: [
          change("f/factory/lib/new.test.ts", {
            status: "added",
            removedLineCount: 0,
          }),
        ],
        prChangedPaths: [],
      }).ok,
    ).toBe(true);
  });

  test("rejects a modified test file the pull request did not change", () => {
    expect(
      codeOf([change("tests/lib/old.test.ts", { removedLineCount: 0 })]),
    ).toBe("not_in_pull_request");
  });

  test("rejects a path that differs only in case from a changed file", () => {
    expect(
      codeOf(
        [change("F/factory/lib/Feature.ts")],
        ["f/factory/lib/feature.ts"],
      ),
    ).toBe("case_variant_path");
  });
});

describe("unsafe paths", () => {
  test.each([
    ["an empty path", ""],
    ["an absolute path", "/etc/passwd"],
    ["a drive path", "C:/Windows/x"],
    ["a parent segment", "a/../b.ts"],
    ["a leading parent segment", "../a.ts"],
    ["a dot segment", "a/./b.ts"],
    ["a leading dot segment", "./a.ts"],
    ["a trailing slash", "a/b/"],
    ["an empty segment", "a//b.ts"],
    ["a backslash", "a\\b.ts"],
    ["a NUL character", "a\u0000b.ts"],
    ["a newline", "a\nb.ts"],
    ["a bidirectional control character", "a\u202Eb.ts"],
    ["a zero-width character", "a\u200Bb.ts"],
    ["a .git segment", ".git/hooks/pre-commit"],
    ["a .GIT segment", "sub/.GIT/config"],
    ["a decomposed Unicode name", "docs/\u30AB\u3099.md"],
    ["a fullwidth name", "docs/\uFF41.md"],
  ])("rejects %s", (_label, path) => {
    expect(codeOf([change(path)], [path])).toBe("unsafe_path");
  });

  test("keeps an unsafe path out of the violation as it was", () => {
    const verdict = checkCiFixChanges({
      changes: [change("a\u202Eb\n.ts")],
      prChangedPaths: [],
    });
    expect(verdict.ok ? "" : verdict.violations[0]?.path).toBe("ab .ts");
  });

  test("shortens a very long path in the violation", () => {
    const verdict = checkCiFixChanges({
      changes: [change("a/../".concat("x".repeat(1000)))],
      prChangedPaths: [],
    });
    expect(
      verdict.ok ? 0 : verdict.violations[0]?.path.length,
    ).toBeLessThanOrEqual(120);
  });
});

describe("file modes and unsupported changes", () => {
  const PATH = "f/factory/lib/feature.ts";
  const codeWithMode = (mode: string) =>
    codeOf([change(PATH, { mode })], [PATH]);

  test("rejects a symbolic link", () => {
    expect(codeWithMode("120000")).toBe("symlink");
  });

  test("rejects a type change", () => {
    expect(codeOf([change(PATH, { status: "typechange" })], [PATH])).toBe(
      "symlink",
    );
  });

  test("rejects a submodule", () => {
    expect(codeWithMode("160000")).toBe("unsupported_change");
  });

  test.each(["100664", "040000", "000000", "", "abc", "100644 "])(
    "rejects the mode %p",
    (mode) => {
      expect(codeWithMode(mode)).toBe("unsupported_change");
    },
  );

  test("allows an executable file", () => {
    expect(allowed(PATH, { mode: "100755" })).toBe(true);
  });

  test("allows a regular file", () => {
    expect(allowed(PATH, { mode: "100644" })).toBe(true);
  });

  test("rejects an unknown status", () => {
    expect(codeOf([change(PATH, { status: "unknown" })], [PATH])).toBe(
      "unsupported_change",
    );
  });
});

describe("protected paths", () => {
  test.each([
    ".github/workflows/ci.yml",
    ".github/dependabot.yml",
    ".claude/settings.json",
    ".claude/skills/factory-fix/SKILL.md",
    ".agents/skills/x/SKILL.md",
    "wmill.yaml",
    "wmill-lock.yaml",
    "console/src/main.tsx",
    "console/src/components/Foo.tsx",
    "scripts/lint-no-type-assertions.ts",
    "scripts/ci-scope.ts",
    "tsconfig.json",
    "tsconfig.wmill.json",
    "console/tsconfig.app.json",
    "biome.json",
    "biome.jsonc",
    "mise.toml",
    "mise.local.toml",
    "lefthook.yml",
    "package.json",
    "console/package.json",
    "bun.lock",
    "console/bun.lock",
    "package-lock.json",
    "pnpm-lock.yaml",
    "f/factory/lib/foo.script.lock",
    "f/factory/steps/bar.script.lock",
    ".gitleaks.toml",
    ".gitleaksignore",
    ".env",
    ".env.local",
    "vite.config.ts",
    "infra/docker-compose.yml",
    "infra/Caddyfile",
    "migrations/datatable/main/001_x.sql",
    "f/factory/lib/claude.ts",
    "f/factory/lib/claude.script.yaml",
    "f/factory/lib/protected_paths.ts",
    "f/factory/lib/log.ts",
    "f/factory/lib/workspace.ts",
    "f/factory/lib/check_sandbox.ts",
    "f/factory/steps/pr_workflow_support.ts",
    "f/factory/steps/pr_fix_apply.ts",
    "f/factory/steps/pr_fix_apply.script.yaml",
    "f/factory/steps/pr_fix_prepare.ts",
    "f/factory/lib/ci_log_support.ts",
    "f/factory/lib/ci_fix_paths.ts",
    "f/factory/lib/ci_fix_prompt.ts",
    "f/factory/lib/ci_fix_classify.ts",
    "f/factory/lib/ci_log_support.script.yaml",
    "f/factory/lib/pr_ci_support.ts",
    "f/factory/lib/pr_ci_watch.ts",
    "f/factory/lib/pr_fix_launch.ts",
    "f/factory/lib/pr_fix_launch.script.yaml",
    "f/factory/lib/main_ci_support.ts",
    "f/factory/lib/metadata_hash.ts",
    "f/factory/lib/metadata_precheck.script.yaml",
    "f/factory/lib/metadata_signature.ts",
    "f/factory/lib/metadata_git_ports.ts",
    "f/factory/lib/metadata_git_ports.script.yaml",
    "f/factory/lib/metadata_git_ports.script.lock",
    "f/factory/lib/ci_metadata_rehash.ts",
    "f/factory/lib/ci_metadata_rehash.script.yaml",
    "f/factory/lib/ci_metadata_rehash.script.lock",
    "f/factory/lib/metadata_patch_verify.ts",
    "f/factory/watch_pr_ci.ts",
    "f/factory/dependabot__flow/flow.yaml",
    "f/factory/pr_fix__flow/flow.yaml",
    "f/factory/poll_prs.schedule.yaml",
    "f/factory/github_token.variable.yaml",
    "console/index.html",
    "f/factory/lib/prompts.ts",
    "f/factory/lib/prompts.script.yaml",
    "f/factory/lib/github.ts",
    "f/factory/lib/github.script.lock",
    "f/factory/lib/check_runner.ts",
    "f/factory/watch_main_ci.ts",
    "f/factory/watch_main_ci.script.yaml",
    ".mcp.json",
    "sub/.mcp.json",
    "f/factory/foo.resource-type.yaml",
    "f/factory/lib/types.ts",
    "f/factory/lib/types.script.yaml",
    "f/factory/lib/job_tmp.ts",
    "f/factory/lib/check_sandbox_reasons.ts",
    "f/factory/lib/check_sandbox_reasons.script.yaml",
    "f/factory/lib/github_errors.ts",
    "f/factory/lib/github_errors.script.yaml",
    "f/factory/lib/repo_owner_gate.ts",
    "f/factory/lib/model_policy.ts",
    "f/factory/lib/config.ts",
    "f/factory/lib/host_action.ts",
    "f/factory/lib/process_lock.ts",
    "f/factory/lib/factory_repo_gate.ts",
    "f/factory/lib/pr_conflict_support.ts",
    "f/factory/lib/pr_conflict_fix_claim.ts",
    "f/factory/lib/pr_conflict_fix_recovery.script.yaml",
    "f/factory/lib/conflict_fix_round.ts",
    "f/factory/lib/conflict_fix_prompt.ts",
    "f/factory/watch_pr_conflicts.ts",
    "f/factory/watch_pr_conflicts.script.yaml",
    "f/factory/lib/auto_retry_reasons.ts",
    "f/factory/lib/auto_retry_reasons.script.yaml",
    "f/factory/lib/auto_retry_reasons.script.lock",
    "f/factory/lib/gh_graphql.ts",
    "f/factory/lib/gh_graphql.script.yaml",
    "f/factory/lib/gh_collect.ts",
    "f/factory/lib/gh_collect.script.yaml",
    "f/factory/lib/gh_collect_support.ts",
    "f/factory/lib/gh_collect_support.script.lock",
    "f/factory/lib/gh_collect_freshness.ts",
    "f/factory/lib/gh_collect_freshness.script.yaml",
    "f/factory/lib/gh_collect_freshness.script.lock",
    "f/factory/collect_github.ts",
    "f/factory/collect_github.script.yaml",
    "f/factory/collect_github.schedule.yaml",
    "f/factory/github_read_tokens.variable.yaml",
  ])("rejects %s even when the pull request changed it", (path) => {
    expect(codeOf([change(path)], [path])).toBe("protected_path");
  });

  test.each([
    ".GitHub/workflows/ci.yml",
    ".CLAUDE/settings.json",
    "WMILL.YAML",
    "Package.JSON",
    "F/Factory/Lib/Claude.ts",
    "Console/SRC/main.tsx",
    "Scripts/x.ts",
  ])("rejects %s regardless of case", (path) => {
    expect(codeOf([change(path)], [path])).toBe("protected_path");
  });

  test("rejects a protected new test file", () => {
    expect(
      codeOf([
        change("tests/lib/drawio_frame_isolation.test.ts", {
          status: "added",
          removedLineCount: 0,
        }),
      ]),
    ).toBe("protected_path");
  });

  test("rejects a new test file under a protected directory", () => {
    expect(
      codeOf([
        change("scripts/x.test.ts", { status: "added", removedLineCount: 0 }),
      ]),
    ).toBe("protected_path");
  });

  test.each([
    ".gitignore",
    "tests/.gitignore",
    "tests/lib/deep/.gitignore",
    "f/factory/.ignore",
    "tests/.prettierignore",
    "tests/.eslintignore",
    "tests/.dockerignore",
    "tests/.npmignore",
    "tests/.markdownlintignore",
    "tests/.editorconfig",
    "tests/.GitIgnore",
  ])("rejects a new ignore or editor file %s under tests", (path) => {
    expect(
      codeOf([change(path, { status: "added", removedLineCount: 0 })]),
    ).toBe("protected_path");
  });

  test.each([
    "conftest.py",
    "tests/conftest.py",
    "tests/lib/deep/conftest.py",
    "tests/pytest.ini",
    "tests/tox.ini",
    "tests/.mocharc.json",
    "tests/.mocharc.cjs",
    "tests/.coveragerc",
    "tests/.nycrc.json",
    "tests/.c8rc.json",
    "tests/vitest.setup.ts",
    "tests/jest.setup.js",
    "tests/Conftest.py",
  ])("rejects a new test runner setting %s under tests", (path) => {
    expect(
      codeOf([change(path, { status: "added", removedLineCount: 0 })]),
    ).toBe("protected_path");
  });

  test("rejects deleting an ignore file under tests", () => {
    expect(
      codeOf([
        change("tests/.gitignore", {
          status: "deleted",
          addedLines: [],
        }),
      ]),
    ).toBe("protected_path");
  });

  test("does not treat a similarly named source file as a safety device", () => {
    expect(allowed("f/factory/lib/logger_helper.ts")).toBe(true);
  });
});

describe("tests", () => {
  const TEST = "tests/lib/foo.test.ts";

  test("allows additions to an existing test the pull request changed", () => {
    expect(allowed(TEST, { removedLineCount: 0 })).toBe(true);
  });

  test("rejects a modification that removes test lines", () => {
    expect(codeOf([change(TEST, { removedLineCount: 2 })], [TEST])).toBe(
      "test_not_additive",
    );
  });

  test("rejects deleting a test", () => {
    expect(
      codeOf([change(TEST, { status: "deleted", addedLines: [] })], [TEST]),
    ).toBe("test_not_additive");
  });

  test("rejects a modification of a spec file that removes lines", () => {
    const path = "f/factory/lib/foo.spec.ts";
    expect(codeOf([change(path, { removedLineCount: 1 })], [path])).toBe(
      "test_not_additive",
    );
  });

  test("applies the additive rule to a fixture", () => {
    const path = "tests/fixtures/data.json";
    expect(codeOf([change(path, { removedLineCount: 1 })], [path])).toBe(
      "test_not_additive",
    );
  });

  test("allows a source file change that removes lines", () => {
    expect(allowed("f/factory/lib/feature.ts", { removedLineCount: 40 })).toBe(
      true,
    );
  });
});

describe("weakening checks", () => {
  test.each([
    "// biome-ignore lint/suspicious/noExplicitAny: reason",
    "// @ts-ignore",
    "// @ts-expect-error",
    "// @ts-nocheck",
    "test.skip('x', () => {})",
    "describe.skip('x', () => {})",
    "it.only('x', () => {})",
    "test .only ('x', () => {})",
    "test.only",
    "const t = describe.skip;",
    "test.skip.each([1])('x', () => {})",
    "test.todo('x')",
    "it.todo",
    "it.failing('x', () => {})",
    "test.failing",
    "test.if(cond)('x', () => {})",
    "test.runIf(cond)('x', () => {})",
    "test.skipIf(cond)('x', () => {})",
    "test.todoIf(cond)('x', () => {})",
    "test['skip']('x', () => {})",
    'describe["only"]("x", () => {})',
    "test[`todo`]('x')",
    "{ skip: true }",
    "defineTest({ skip:true })",
    "xit('x', () => {})",
    "xtest('x', () => {})",
    "xdescribe('x', () => {})",
    "fit('x', () => {})",
    "fdescribe('x', () => {})",
    "process.exit(0)",
    "process .exit (1)",
    "mock.module('./x.ts', () => ({}))",
    "/* eslint-disable */",
    "// eslint-disable-next-line no-console",
    "/* istanbul ignore next */",
    "/* c8 ignore next */",
    "/* v8 ignore next */",
    "x = 1  # noqa",
    "x = 1  # type: ignore",
    "// nolint",
    "const k = 'abc'; // gitleaks:allow",
    "// BIOME-IGNORE lint: x",
    "<!-- markdownlint-disable MD013 -->",
    "<!-- markdownlint-capture -->",
    '<!-- markdownlint-configure-file { "default": false } -->',
    "<!-- textlint-disable -->",
    "spyOn(client, 'run')",
    "jest.spyOn(client, 'run')",
    "vi.mock('./x.ts')",
    "jest . mock ('./x.ts')",
    "fn.mockImplementation(() => 1)",
    "fn.mockReturnValue(1)",
    "fn.mockReturnValueOnce(1)",
    "fn.mockResolvedValue(1)",
  ])("rejects an added line: %s", (line) => {
    const path = "f/factory/lib/feature.ts";
    expect(codeOf([change(path, { addedLines: [line] })], [path])).toBe(
      "weakens_checks",
    );
  });

  test("rejects a weakening line in a new test file", () => {
    expect(
      codeOf([
        change("tests/lib/new.test.ts", {
          status: "added",
          removedLineCount: 0,
          addedLines: ["test.skip('x', () => {});"],
        }),
      ]),
    ).toBe("weakens_checks");
  });

  test("rejects a weakening line in a document too", () => {
    const path = "docs/guide.md";
    expect(
      codeOf(
        [change(path, { addedLines: ["<!-- eslint-disable -->"] })],
        [path],
      ),
    ).toBe("weakens_checks");
  });

  test("allows ordinary added lines that mention skipping in prose", () => {
    expect(
      allowed("f/factory/lib/feature.ts", {
        addedLines: ["// the loader skips empty files", "const skipped = 1;"],
      }),
    ).toBe(true);
  });

  test("allows identifiers that only start with a skipping word", () => {
    expect(
      allowed("f/factory/lib/feature.ts", {
        addedLines: ["const onlyOne = list.onlyOne; items.skipped();"],
      }),
    ).toBe(true);
  });

  test("does not flag a bare if (false) because it is too noisy", () => {
    expect(
      allowed("f/factory/lib/feature.ts", { addedLines: ["if (false) {"] }),
    ).toBe(true);
  });
});

describe("reporting", () => {
  test("reports every violating change", () => {
    const verdict = checkCiFixChanges({
      changes: [change("wmill.yaml"), change("f/factory/lib/other.ts")],
      prChangedPaths: [],
    });
    expect(verdict.ok ? [] : verdict.violations.map((v) => v.code)).toEqual([
      "protected_path",
      "not_in_pull_request",
    ]);
  });

  test("reports the path of the violation", () => {
    const verdict = checkCiFixChanges({
      changes: [change("wmill.yaml")],
      prChangedPaths: [],
    });
    expect(verdict.ok ? "" : verdict.violations[0]?.path).toBe("wmill.yaml");
  });

  test("reports one violation per change", () => {
    const verdict = checkCiFixChanges({
      changes: [change("wmill.yaml", { addedLines: ["// @ts-ignore"] })],
      prChangedPaths: [],
    });
    expect(verdict.ok ? 0 : verdict.violations.length).toBe(1);
  });
});

/**
 * 拒否した安全装置が直接importするのに、拒否しないモジュールと、受け入れる理由。
 * 安全装置の挙動を変えうる依存は、拒否の一覧に入れる。
 * ここに書くのは、ほかのフローが日常的に直す共有モジュールで、拒否すると正当な修正を止めるものに限る。
 * 一覧に無い依存が増えたとき、または一覧の項目が使われなくなったときは、このテストが赤くなる。
 */
const ACCEPTED_DEPENDENCIES: Readonly<Record<string, string>> = {
  "f/factory/lib/db.ts":
    "DBの読み書きの共有モジュール。多くのフローが日常的に直す。起動の歯止めのSQLを含む。CI回がdb.tsを変えても反映はマージ後で、レビューが受け皿になる",
  "f/factory/lib/discord.ts":
    "Discord通知の共有モジュール。通知の文面を直す変更が多い",
  "f/factory/lib/poll_support.ts":
    "PRのポーリングの判定の共有モジュール。フローの挙動を直す変更が多い",
  "f/factory/lib/implement_support.ts":
    "実装フローの共有モジュール。実装フローの修正が日常的に触れる",
  "f/factory/lib/implement_launch_support.ts":
    "実装フローの起動の共有モジュール。実装フローの修正が日常的に触れる",
  "f/factory/lib/implement_loop.ts":
    "実装フローの検証ループ。実装フローの修正が日常的に触れる",
  "f/factory/lib/implement_finish_support.ts":
    "実装フローの終了処理の共有モジュール。実装フローの修正が日常的に触れる",
  "f/factory/lib/factory_clone.ts":
    "Factory自身のcloneを用意する共有モジュール。ほかのフローが日常的に使う",
  "f/factory/lib/self_update_support.ts":
    "自己更新の判定と整形の純粋関数。self_updateの修正が日常的に触れる",
  "f/factory/lib/job_ids.ts": "WindmillのジョブIDの形の検査。依存が無く小さい",
  "f/factory/lib/prose_check.ts":
    "文書の文章の検査。文書の規則を直す変更が日常的に触れる",
  "f/factory/lib/console_support.ts":
    "通知の重要度と対象の定数。通知の種類を足す変更が日常的に触れる。競合の通知の種類を読むだけで、判断には使わない",
  "f/factory/lib/owner_id_notice.ts":
    "owner_idの照合のnoticeの種類と本文を組み立てるだけで、通信と判定を持たない。poll_support.tsが再エクスポートし、PRのポーリングでも使う。CI回が変えても影響はnoticeの文面と解決の照合に限られ、レビューが受け皿になる",
};

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** 静的なimportとexport fromが指す、リポジトリのルートからの相対パス。 */
function importedPaths(path: string, source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(
    /(?:import|export)\s[^;]*?from\s+"(\.[^"]+)"/g,
  )) {
    found.push(normalize(join(dirname(path), match[1] ?? "")));
  }
  return found;
}

describe("dependencies of the denied safety files", () => {
  /** 拒否したファイルごとの、拒否していない依存。 */
  async function undeniedDependencies(): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    const glob = new Bun.Glob("f/factory/**/*.ts");
    for await (const path of glob.scan({ cwd: REPO_ROOT })) {
      if (!isDeniedPath(path)) continue;
      const source = await Bun.file(join(REPO_ROOT, path)).text();
      for (const target of importedPaths(path, source)) {
        if (isDeniedPath(target)) continue;
        result.set(target, [...(result.get(target) ?? []), path]);
      }
    }
    return result;
  }

  test("every dependency is denied or accepted with a reason", async () => {
    const unexplained = [...(await undeniedDependencies()).keys()].filter(
      (target) => !(target in ACCEPTED_DEPENDENCIES),
    );
    expect(unexplained).toEqual([]);
  });

  test("every accepted dependency is still imported by a denied file", async () => {
    const used = await undeniedDependencies();
    const stale = Object.keys(ACCEPTED_DEPENDENCIES).filter(
      (target) => !used.has(target),
    );
    expect(stale).toEqual([]);
  });

  test("no accepted dependency is denied", () => {
    const denied = Object.keys(ACCEPTED_DEPENDENCIES).filter(isDeniedPath);
    expect(denied).toEqual([]);
  });

  test("owner_id_notice.ts is not denied, so the collection can read it", () => {
    expect(isDeniedPath("f/factory/lib/owner_id_notice.ts")).toBe(false);
  });

  test("the scan finds the denied files", async () => {
    const glob = new Bun.Glob("f/factory/lib/claude.ts");
    const found: string[] = [];
    for await (const path of glob.scan({ cwd: REPO_ROOT })) found.push(path);
    expect(found.filter(isDeniedPath)).toEqual(["f/factory/lib/claude.ts"]);
  });
});

describe("weakensChecks", () => {
  test("is true when any line suppresses a check", () => {
    expect(weakensChecks(["const a = 1;", "// @ts-ignore"])).toBe(true);
  });

  test("is false when no line weakens a check", () => {
    expect(weakensChecks(["const a = 1;", "return a;"])).toBe(false);
  });

  test("is false for an empty list", () => {
    expect(weakensChecks([])).toBe(false);
  });
});

describe("isTestPath", () => {
  test("recognizes a test file name", () => {
    expect(isTestPath("src/a.test.ts")).toBe(true);
  });

  test("does not recognize an ordinary source file", () => {
    expect(isTestPath("src/a.ts")).toBe(false);
  });
});

describe("isDeniedPath with Unicode aliases", () => {
  test("denies a capital sharp s that folds to ss", () => {
    expect(isDeniedPath("f/factory/steps/dependabot_aẞeẞ.ts")).toBe(true);
  });

  test("denies a long s alias of an exact protected path", () => {
    expect(isDeniedPath("ſcripts/doctor.sh")).toBe(true);
  });

  test("denies a fullwidth alias of a protected directory", () => {
    expect(isDeniedPath("．claude/settings.json")).toBe(true);
  });

  test("denies a path with a zero-width character inserted", () => {
    expect(isDeniedPath(".cla​ude/settings.json")).toBe(true);
  });

  test("denies a name whose slash only appears after normalization", () => {
    expect(isDeniedPath("sub/.env.℀")).toBe(true);
  });

  test("denies a name that composes into another character", () => {
    expect(isDeniedPath("sub/requirementś.txt")).toBe(true);
  });

  test.each([
    ".cla͏ude/settings.json",
    "scrıpts/doctor.sh",
    "f/factory/lib/ci️_fix_paths.ts",
  ])("reports protected_path, not unsafe_path, for %s", (path) => {
    expect(codeOf([change(path)], [path])).toBe("protected_path");
  });

  test("does not deny an unrelated path", () => {
    expect(isDeniedPath("docs/Readme.md")).toBe(false);
  });
});

describe("files of the conflict round", () => {
  test.each([
    "f/factory/lib/conflict_fix_round.ts",
    "f/factory/lib/workspace.ts",
    "f/factory/lib/ci_fix_paths.ts",
  ])("denies %s", (path) => {
    expect(isDeniedPath(path)).toBe(true);
  });
});
