import { describe, expect, test } from "bun:test";
import {
  type CiFixChange,
  type CiFixViolationCode,
  checkCiFixChanges,
} from "../../f/factory/lib/ci_fix_paths.ts";

const change = (
  path: string,
  overrides: Partial<CiFixChange> = {},
): CiFixChange => ({
  path,
  status: "modified",
  symlink: false,
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

describe("symlinks and unsupported changes", () => {
  test("rejects a symbolic link", () => {
    expect(
      codeOf(
        [change("f/factory/lib/feature.ts", { symlink: true })],
        ["f/factory/lib/feature.ts"],
      ),
    ).toBe("symlink");
  });

  test("rejects a type change", () => {
    expect(
      codeOf(
        [change("f/factory/lib/feature.ts", { status: "typechange" })],
        ["f/factory/lib/feature.ts"],
      ),
    ).toBe("symlink");
  });

  test("rejects an unknown status", () => {
    expect(
      codeOf(
        [change("f/factory/lib/feature.ts", { status: "unknown" })],
        ["f/factory/lib/feature.ts"],
      ),
    ).toBe("unsupported_change");
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
    "f/factory/lib/main_ci_support.ts",
    "f/factory/watch_pr_ci.ts",
    "f/factory/dependabot__flow/flow.yaml",
    "f/factory/pr_fix__flow/flow.yaml",
    "f/factory/poll_prs.schedule.yaml",
    "f/factory/github_token.variable.yaml",
    "console/index.html",
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
    "test.todo('x')",
    "it.todo",
    "test.skipIf(cond)('x', () => {})",
    "xit('x', () => {})",
    "xdescribe('x', () => {})",
    "fit('x', () => {})",
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

  test("allows a property access named only", () => {
    expect(
      allowed("f/factory/lib/feature.ts", {
        addedLines: ["const onlyOne = list.only;"],
      }),
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
