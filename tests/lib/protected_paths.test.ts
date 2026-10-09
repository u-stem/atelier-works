import { describe, expect, test } from "bun:test";
import {
  FORBIDDEN_PATH_PREFIXES,
  IMPLEMENT_PROTECTED_PATH_PREFIXES,
  isNewShellScript,
  matchesForbiddenPath,
  matchesImplementProtectedPath,
} from "../../f/factory/lib/protected_paths.ts";
// 名前付きインポートの別名ではなく名前空間インポートにしている。
// pre-commitの`as`禁止検査はトークン単位のヒューリスティックで、
// `import * as name`は例外扱いするが`{ name as alias }`は扱わないため、
// 別名にするとこの`as`を誤検知する。
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
      "console/public/",
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

  test("matches console/index.html", () => {
    expect(matchesForbiddenPath("console/index.html")).toBe(true);
  });

  test("matches console/index.html after stripping a leading ./", () => {
    expect(matchesForbiddenPath("./console/index.html")).toBe(true);
  });

  test("matches console/drawio-viewer.json", () => {
    expect(matchesForbiddenPath("console/drawio-viewer.json")).toBe(true);
  });

  test("matches console/scripts/drawio-viewer.ts", () => {
    expect(matchesForbiddenPath("console/scripts/drawio-viewer.ts")).toBe(true);
  });

  test("matches console/scripts/fetch-drawio-viewer.ts", () => {
    expect(matchesForbiddenPath("console/scripts/fetch-drawio-viewer.ts")).toBe(
      true,
    );
  });

  test("matches console/scripts/manifest.ts", () => {
    expect(matchesForbiddenPath("console/scripts/manifest.ts")).toBe(true);
  });

  test("matches console/scripts/write-manifest.ts", () => {
    expect(matchesForbiddenPath("console/scripts/write-manifest.ts")).toBe(
      true,
    );
  });

  test("matches scripts/check-console-lockfile.ts", () => {
    expect(matchesForbiddenPath("scripts/check-console-lockfile.ts")).toBe(
      true,
    );
  });

  test("matches console/scripts/asset-name.ts", () => {
    expect(matchesForbiddenPath("console/scripts/asset-name.ts")).toBe(true);
  });

  test("matches console/vite.config.ts", () => {
    expect(matchesForbiddenPath("console/vite.config.ts")).toBe(true);
  });

  test("does not match other console scripts", () => {
    expect(matchesForbiddenPath("console/scripts/public-assets.test.ts")).toBe(
      false,
    );
  });

  test("does not match a manifest.ts outside console/scripts/", () => {
    expect(matchesForbiddenPath("console/src/lib/manifest.ts")).toBe(false);
  });

  test("does not match a drawio-viewer.json outside console/", () => {
    expect(matchesForbiddenPath("docs/drawio-viewer.json")).toBe(false);
  });

  test("matches files under console/public/", () => {
    expect(
      matchesForbiddenPath("console/public/assets/theme-init-ba7816bf.js"),
    ).toBe(true);
  });

  test("does not match ordinary console sources", () => {
    expect(matchesForbiddenPath("console/src/App.tsx")).toBe(false);
  });

  test("does not match an index.html outside console/", () => {
    expect(matchesForbiddenPath("docs/index.html")).toBe(false);
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

  test("matches console/scripts/asset-name.ts", () => {
    expect(matchesImplementProtectedPath("console/scripts/asset-name.ts")).toBe(
      true,
    );
  });

  test("matches console/vite.config.ts", () => {
    expect(matchesImplementProtectedPath("console/vite.config.ts")).toBe(true);
  });

  test("matches console/index.html", () => {
    expect(matchesImplementProtectedPath("console/index.html")).toBe(true);
  });

  test("matches console/drawio-viewer.json", () => {
    expect(matchesImplementProtectedPath("console/drawio-viewer.json")).toBe(
      true,
    );
  });

  test("matches console/scripts/drawio-viewer.ts", () => {
    expect(
      matchesImplementProtectedPath("console/scripts/drawio-viewer.ts"),
    ).toBe(true);
  });

  test("matches console/scripts/fetch-drawio-viewer.ts", () => {
    expect(
      matchesImplementProtectedPath("console/scripts/fetch-drawio-viewer.ts"),
    ).toBe(true);
  });

  test("matches console/scripts/manifest.ts", () => {
    expect(matchesImplementProtectedPath("console/scripts/manifest.ts")).toBe(
      true,
    );
  });

  test("matches console/scripts/write-manifest.ts", () => {
    expect(
      matchesImplementProtectedPath("console/scripts/write-manifest.ts"),
    ).toBe(true);
  });

  test("matches scripts/check-console-lockfile.ts", () => {
    expect(
      matchesImplementProtectedPath("scripts/check-console-lockfile.ts"),
    ).toBe(true);
  });

  test("matches files under console/public/", () => {
    expect(
      matchesImplementProtectedPath(
        "console/public/assets/theme-init-ba7816bf.js",
      ),
    ).toBe(true);
  });

  test("does not match ordinary console sources", () => {
    expect(matchesImplementProtectedPath("console/src/App.tsx")).toBe(false);
  });

  test("does not match an index.html outside console/", () => {
    expect(matchesImplementProtectedPath("docs/index.html")).toBe(false);
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

describe("lint configs that can load code", () => {
  test.each([
    ".markdownlint-cli2.jsonc",
    ".markdownlint-cli2.yaml",
    ".markdownlint-cli2.cjs",
    ".markdownlint-cli2.mjs",
    ".markdownlint.json",
    ".markdownlint.yml",
    ".markdownlint.js",
    "docs/.markdownlint.jsonc",
  ])("matchesForbiddenPath matches %s", (path) => {
    expect(matchesForbiddenPath(path)).toBe(true);
  });

  test.each([
    ".textlintrc",
    ".textlintrc.json",
    ".textlintrc.yml",
    ".textlintrc.js",
    "docs/.textlintrc.json",
  ])("matchesForbiddenPath matches %s", (path) => {
    expect(matchesForbiddenPath(path)).toBe(true);
  });

  test.each([".markdownlint-cli2.jsonc", ".textlintrc.json"])(
    "matchesImplementProtectedPath matches %s",
    (path) => {
      expect(matchesImplementProtectedPath(path)).toBe(true);
    },
  );

  test.each([
    "docs/markdownlint.md",
    "textlintrc.json",
    ".markdownlint-cli2.jsonc.md",
  ])("matchesForbiddenPath does not match %s", (path) => {
    expect(matchesForbiddenPath(path)).toBe(false);
  });
});
