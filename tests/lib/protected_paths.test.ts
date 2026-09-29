import { describe, expect, test } from "bun:test";
import {
  FORBIDDEN_PATH_PREFIXES,
  IMPLEMENT_PROTECTED_PATH_PREFIXES,
  isNewShellScript,
  matchesForbiddenPath,
  matchesImplementProtectedPath,
} from "../../f/factory/lib/protected_paths.ts";
// Namespace import (not a renamed named import) so the pre-commit
// no-type-assertions lint's token heuristic — which special-cases
// `import * as name` but not `{ name as alias }` — does not false-positive
// on this `as`.
import * as prWorkflowSupport from "../../f/factory/steps/pr_workflow_support.ts";

describe("IMPLEMENT_PROTECTED_PATH_PREFIXES", () => {
  test("widens .github/workflows/ to .github/ and adds the hook, package-manager and devcontainer dirs", () => {
    expect(IMPLEMENT_PROTECTED_PATH_PREFIXES).toEqual([
      ".claude/",
      ".agents/",
      ".github/",
      ".mise/",
      ".config/mise/",
      ".lefthook/",
      "infra/",
      ".husky/",
      ".githooks/",
      ".yarn/",
      ".devcontainer/",
    ]);
  });

  test("leaves the pr_fix list itself without infra/", () => {
    expect(FORBIDDEN_PATH_PREFIXES).not.toContain("infra/");
  });
});

describe("matchesForbiddenPath", () => {
  test("does not match infra/** with the default (pr_fix) prefixes", () => {
    expect(matchesForbiddenPath("infra/worker/Dockerfile")).toBe(false);
  });

  test("matches infra/** with the implement prefixes", () => {
    expect(
      matchesForbiddenPath(
        "infra/worker/Dockerfile",
        IMPLEMENT_PROTECTED_PATH_PREFIXES,
      ),
    ).toBe(true);
  });

  test("matches the bare infra directory entry with the implement prefixes", () => {
    expect(
      matchesForbiddenPath("infra", IMPLEMENT_PROTECTED_PATH_PREFIXES),
    ).toBe(true);
  });

  test("does not match a path that merely starts with the letters infra", () => {
    expect(
      matchesForbiddenPath(
        "infrastructure/notes.md",
        IMPLEMENT_PROTECTED_PATH_PREFIXES,
      ),
    ).toBe(false);
  });

  test("still matches a basename pattern regardless of the prefix list", () => {
    expect(
      matchesForbiddenPath(
        "packages/app/lefthook.yml",
        IMPLEMENT_PROTECTED_PATH_PREFIXES,
      ),
    ).toBe(true);
  });

  test("strips a leading ./ before matching", () => {
    expect(matchesForbiddenPath("./.claude/settings.json")).toBe(true);
  });

  test("is the same function pr_workflow_support.ts re-exports", () => {
    expect(prWorkflowSupport.matchesForbiddenPath).toBe(matchesForbiddenPath);
  });
});

describe("matchesImplementProtectedPath", () => {
  test("matches anything under .github/, not only workflows", () => {
    expect(matchesImplementProtectedPath(".github/dependabot.yml")).toBe(true);
  });

  test("matches git hook directories (.husky/, .githooks/)", () => {
    expect(matchesImplementProtectedPath(".husky/pre-commit")).toBe(true);
  });

  test("matches the yarn directory", () => {
    expect(matchesImplementProtectedPath(".yarn/plugins/x.cjs")).toBe(true);
  });

  test("matches the devcontainer directory", () => {
    expect(
      matchesImplementProtectedPath(".devcontainer/devcontainer.json"),
    ).toBe(true);
  });

  test("matches infra/", () => {
    expect(matchesImplementProtectedPath("infra/worker/Dockerfile")).toBe(true);
  });

  test("still matches pr_fix's basename patterns", () => {
    expect(matchesImplementProtectedPath("packages/app/lefthook.yml")).toBe(
      true,
    );
  });

  test("matches Python lockfiles and manifests", () => {
    expect(
      [
        "uv.lock",
        "svc/poetry.lock",
        "Pipfile",
        "Pipfile.lock",
        "pyproject.toml",
        "setup.py",
        "setup.cfg",
        "requirements.txt",
        "requirements-dev.txt",
      ].every(matchesImplementProtectedPath),
    ).toBe(true);
  });

  test("matches Rust's Cargo files", () => {
    expect(
      ["Cargo.lock", "crates/core/Cargo.toml"].every(
        matchesImplementProtectedPath,
      ),
    ).toBe(true);
  });

  test("matches Go's module files", () => {
    expect(
      ["go.mod", "tools/go.sum"].every(matchesImplementProtectedPath),
    ).toBe(true);
  });

  test("matches Ruby's Gemfile", () => {
    expect(
      ["Gemfile", "Gemfile.lock"].every(matchesImplementProtectedPath),
    ).toBe(true);
  });

  test("matches PHP's composer files", () => {
    expect(
      ["composer.json", "composer.lock"].every(matchesImplementProtectedPath),
    ).toBe(true);
  });

  test("matches .env files", () => {
    expect(matchesImplementProtectedPath("apps/web/.env.local")).toBe(true);
  });

  test("matches gitleaks configuration", () => {
    expect(matchesImplementProtectedPath(".gitleaksignore")).toBe(true);
  });

  test("matches .tool-versions", () => {
    expect(matchesImplementProtectedPath(".tool-versions")).toBe(true);
  });

  test("matches runtime version pins", () => {
    expect(matchesImplementProtectedPath(".bun-version")).toBe(true);
  });

  test("matches .nvmrc", () => {
    expect(matchesImplementProtectedPath(".nvmrc")).toBe(true);
  });

  test("matches the rust toolchain file", () => {
    expect(matchesImplementProtectedPath("rust-toolchain.toml")).toBe(true);
  });

  test("matches yarn configuration", () => {
    expect(matchesImplementProtectedPath(".yarnrc.yml")).toBe(true);
  });

  test("matches the pnpm hook file", () => {
    expect(matchesImplementProtectedPath(".pnpmfile.cjs")).toBe(true);
  });

  test("matches lockfiles", () => {
    expect(matchesImplementProtectedPath("bun.lock")).toBe(true);
  });

  test("matches tool config modules (*.config.[cm][jt]s)", () => {
    expect(matchesImplementProtectedPath("vite.config.mts")).toBe(true);
  });

  test("matches linter and transpiler rc files", () => {
    expect(matchesImplementProtectedPath(".eslintrc.json")).toBe(true);
  });

  test("matches task runners and repository-level tool files", () => {
    expect(matchesImplementProtectedPath("Justfile")).toBe(true);
  });

  test("matches any package.json change", () => {
    expect(matchesImplementProtectedPath("packages/app/package.json")).toBe(
      true,
    );
  });

  test("does not match ordinary source files", () => {
    expect(matchesImplementProtectedPath("src/config.ts")).toBe(false);
  });

  test("leaves pr_fix's matching of .github/ outside workflows unchanged", () => {
    expect(matchesForbiddenPath(".github/dependabot.yml")).toBe(false);
  });

  test("leaves pr_fix's matching of package.json unchanged", () => {
    expect(matchesForbiddenPath("package.json")).toBe(false);
  });
});

describe("isNewShellScript", () => {
  test("matches an added .SH file case-insensitively", () => {
    expect(isNewShellScript({ path: "bin/RUN.SH", status: "added" })).toBe(
      true,
    );
  });
});
