import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isDeniedPath } from "../../f/factory/lib/ci_fix_paths.ts";
import { EMPTY_LOCK_REFERENCE } from "../../f/factory/lib/metadata_patch_verify.ts";
import { readSourceShape } from "../../f/factory/lib/metadata_signature.ts";
import {
  FORBIDDEN_EXACT_PATHS,
  FORBIDDEN_PATH_PREFIXES,
  foldPath,
  IMPLEMENT_PROTECTED_BASENAME_PATTERNS,
  IMPLEMENT_PROTECTED_EXACT_PATHS,
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
      "infra/console_fetcher/",
      "f/factory/dependabot__flow/",
      "scripts/host_apply/",
      "infra/worker/",
      "mise/",
      "infra/",
      ".husky/",
      ".githooks/",
      ".yarn/",
      ".devcontainer/",
    ]);
  });

  test("keeps .github/actions/ in the pr_fix list", () => {
    expect(FORBIDDEN_PATH_PREFIXES).toContain(".github/actions/");
  });

  test("lists .github/ once for the implement flow", () => {
    expect(
      IMPLEMENT_PROTECTED_PATH_PREFIXES.filter((prefix) =>
        prefix.startsWith(".github/"),
      ),
    ).toEqual([".github/"]);
  });

  test("leaves the pr_fix list itself without infra/", () => {
    expect(FORBIDDEN_PATH_PREFIXES).not.toContain("infra/");
  });
});

describe("matchesForbiddenPath", () => {
  test("matches a composite action under .github/actions/ with the default (pr_fix) prefixes", () => {
    expect(matchesForbiddenPath(".github/actions/build/action.yml")).toBe(true);
  });

  test("matches the console_fetcher files with the default (pr_fix) prefixes", () => {
    expect(matchesForbiddenPath("infra/console_fetcher/fetcher.ts")).toBe(true);
  });

  test("matches infra/Caddyfile with the default (pr_fix) prefixes", () => {
    expect(matchesForbiddenPath("infra/Caddyfile")).toBe(true);
  });

  test("matches infra/Caddyfile with the implement prefixes", () => {
    expect(matchesImplementProtectedPath("infra/Caddyfile")).toBe(true);
  });

  test("does not match infra/** in general with the default (pr_fix) prefixes", () => {
    expect(matchesForbiddenPath("infra/docker-compose.override.yml")).toBe(
      false,
    );
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

  test("matches the script that proposes a new viewer pin", () => {
    expect(matchesForbiddenPath("f/factory/drawio_viewer_bump.ts")).toBe(true);
  });

  test("matches the library that rewrites the viewer pin", () => {
    expect(matchesForbiddenPath("f/factory/lib/drawio_viewer_bump.ts")).toBe(
      true,
    );
  });

  test("matches the GitHub module used only by the viewer pin update", () => {
    expect(
      matchesForbiddenPath("f/factory/lib/drawio_viewer_bump_github.ts"),
    ).toBe(true);
  });

  test("matches the observation record of the viewer pin update", () => {
    expect(
      matchesForbiddenPath("f/factory/lib/drawio_viewer_observations.ts"),
    ).toBe(true);
  });

  test("matches the script definition of the viewer pin update", () => {
    expect(
      matchesForbiddenPath("f/factory/drawio_viewer_bump.script.yaml"),
    ).toBe(true);
  });

  test("matches the schedule definition of the viewer pin update", () => {
    expect(
      matchesForbiddenPath("f/factory/drawio_viewer_bump.schedule.yaml"),
    ).toBe(true);
  });

  test("does not match the dependency-free lock of the library that rewrites the viewer pin", () => {
    expect(
      matchesForbiddenPath("f/factory/lib/drawio_viewer_bump.script.lock"),
    ).toBe(false);
  });

  test("matches the script definition of the library that rewrites the viewer pin", () => {
    expect(
      matchesForbiddenPath("f/factory/lib/drawio_viewer_bump.script.yaml"),
    ).toBe(true);
  });

  test("does not match the dependency-free lock of the GitHub module of the viewer pin update", () => {
    expect(
      matchesForbiddenPath(
        "f/factory/lib/drawio_viewer_bump_github.script.lock",
      ),
    ).toBe(false);
  });

  test("matches the script definition of the observation record", () => {
    expect(
      matchesForbiddenPath(
        "f/factory/lib/drawio_viewer_observations.script.yaml",
      ),
    ).toBe(true);
  });

  test("does not match the lock of the update script, which changes with every windmill-client bump", () => {
    expect(
      matchesForbiddenPath("f/factory/drawio_viewer_bump.script.lock"),
    ).toBe(false);
  });

  test("does not match the lock of the observation record, which pins windmill-client", () => {
    expect(
      matchesForbiddenPath(
        "f/factory/lib/drawio_viewer_observations.script.lock",
      ),
    ).toBe(false);
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

  test("matches scripts/ci-scope.ts", () => {
    expect(matchesForbiddenPath("scripts/ci-scope.ts")).toBe(true);
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

  test("matches a composite action under .github/actions/", () => {
    expect(
      matchesImplementProtectedPath(".github/actions/build/action.yml"),
    ).toBe(true);
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

  test("matches scripts/ci-scope.ts", () => {
    expect(matchesImplementProtectedPath("scripts/ci-scope.ts")).toBe(true);
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

describe("drawio isolation test", () => {
  const path = "tests/lib/drawio_frame_isolation.test.ts";

  test("matchesForbiddenPath matches the test", () => {
    expect(matchesForbiddenPath(path)).toBe(true);
  });

  test("matchesImplementProtectedPath matches the test", () => {
    expect(matchesImplementProtectedPath(path)).toBe(true);
  });
});

describe("script definition lock contract test", () => {
  const path = "tests/lib/script_yaml_lock_contract.test.ts";

  test("matchesForbiddenPath matches the test", () => {
    expect(matchesForbiddenPath(path)).toBe(true);
  });

  test("matchesImplementProtectedPath matches the test", () => {
    expect(matchesImplementProtectedPath(path)).toBe(true);
  });

  test("FORBIDDEN_EXACT_PATHS lists the test", () => {
    expect(FORBIDDEN_EXACT_PATHS).toContain(path);
  });
});

// メタデータのパッチを検査する部品は、書き換えられると、受け取り側の検査が緩む。
// 保護が完全一致の一覧から来ていることを確かめる。
describe("metadata patch manifest files", () => {
  const EXACT = [
    "f/factory/lib/metadata_patch_manifest.ts",
    "f/factory/lib/metadata_patch_manifest.script.yaml",
    "f/factory/lib/metadata_patch_manifest.script.lock",
    "f/factory/lib/metadata_patch_zip.ts",
    "f/factory/lib/metadata_patch_zip.script.yaml",
    "f/factory/lib/metadata_patch_yaml.ts",
    "f/factory/lib/metadata_patch_yaml.script.yaml",
    "f/factory/lib/metadata_patch_verify.ts",
    "f/factory/lib/metadata_patch_verify.script.yaml",
    "f/factory/lib/metadata_patch_imports.ts",
    "f/factory/lib/metadata_patch_imports.script.yaml",
    "f/factory/lib/metadata_patch_download.ts",
    "f/factory/lib/metadata_patch_download.script.yaml",
    "f/factory/lib/metadata_hash.ts",
    "f/factory/lib/metadata_hash.script.yaml",
    "f/factory/lib/metadata_precheck.ts",
    "f/factory/lib/metadata_precheck.script.yaml",
    "f/factory/lib/metadata_signature.ts",
    "f/factory/lib/metadata_signature.script.yaml",
    "f/factory/lib/metadata_git_ports.ts",
    "f/factory/lib/metadata_git_ports.script.yaml",
    "f/factory/lib/ci_metadata_rehash.ts",
    "f/factory/lib/ci_metadata_rehash.script.yaml",
  ];
  const NEAR_MISSES = [
    "f/factory/lib/metadata_patch_manifest.test.ts",
    "f/factory/lib/metadata_patch_manifest.ts.orig",
    "f/factory/lib/metadata_patch_manifest_other.ts",
    "f/factory/steps/metadata_patch_manifest.ts",
    "tests/lib/metadata_patch_manifest.test.ts",
    "f/factory/lib/metadata_patch_verify.test.ts",
    "tests/lib/metadata_patch_verify.test.ts",
    "f/factory/lib/metadata_hash.test.ts",
    "f/factory/lib/ci_metadata_rehash.test.ts",
    "f/factory/lib/ci_metadata_rehash.ts.orig",
    "tests/lib/ci_metadata_rehash.test.ts",
    "f/factory/lib/metadata_hash.ts.orig",
    "tests/lib/metadata_hash.test.ts",
    "tests/lib/metadata_precheck.test.ts",
  ];

  test.each(EXACT)("matchesForbiddenPath matches %s", (path) => {
    expect(matchesForbiddenPath(path)).toBe(true);
  });

  test.each(EXACT)("matchesImplementProtectedPath matches %s", (path) => {
    expect(matchesImplementProtectedPath(path)).toBe(true);
  });

  test.each(EXACT)("FORBIDDEN_EXACT_PATHS lists %s", (path) => {
    expect(FORBIDDEN_EXACT_PATHS).toContain(path);
  });

  test.each(NEAR_MISSES)("matchesForbiddenPath does not match %s", (path) => {
    expect(matchesForbiddenPath(path)).toBe(false);
  });
});

// dependabotの自動マージの判定とフローは、書き換えられると、人の確認なしに
// 任意の更新をマージできる。そのため、まだ存在しないファイルも含めて守る。
// 「理由」は、保護が完全一致の一覧とフローのディレクトリから来ていることである。
// ほかのディレクトリやファイル名の規則に当たって守られているのでは、同名の別のファイルまで巻き込む。
describe("dependabot flow files", () => {
  const SCRIPTS = [
    "f/factory/lib/dependabot_support",
    "f/factory/lib/dependabot_prompt",
    "f/factory/lib/dependabot_registry",
    "f/factory/lib/dependabot_collect",
    "f/factory/lib/dependabot_flow_support",
    "f/factory/poll_dependabot",
    "f/factory/steps/dependabot_prepare",
    "f/factory/steps/dependabot_assess",
    "f/factory/steps/dependabot_finish",
  ];
  // libの依存の無いlockは保護しない(下の「dependency-free lib locks」)。
  // 窓口のscriptとステップのlockは`windmill-client`を含み、その版更新で書き換わる。
  const CLIENT_LOCKS = SCRIPTS.filter(
    (base) => !base.startsWith("f/factory/lib/"),
  ).map((base) => `${base}.script.lock`);
  const EXACT = [
    ...SCRIPTS.flatMap((base) => [`${base}.ts`, `${base}.script.yaml`]),
    "f/factory/poll_dependabot.schedule.yaml",
  ];
  const FLOW_FILES = [
    "f/factory/dependabot__flow/flow.yaml",
    "f/factory/dependabot__flow/inline_step.ts",
    "f/factory/dependabot__flow/modules/step.script.yaml",
  ];
  const PROTECTED = [...EXACT, ...FLOW_FILES];
  const NEAR_MISSES = [
    "f/factory/steps/dependabot_support.ts",
    "f/factory/lib/dependabot_support.test.ts",
    "f/factory/lib/dependabot_support.ts.orig",
    "f/factory/lib/dependabot_other.ts",
    "f/factory/dependabot_flow/flow.yaml",
    "f/factory/poll_dependabot.ts.bak",
    "f/factory/steps/dependabot_prepare.test.ts",
  ];

  test.each(PROTECTED)("matchesForbiddenPath matches %s", (path) => {
    expect(matchesForbiddenPath(path)).toBe(true);
  });

  test.each(PROTECTED)("matchesImplementProtectedPath matches %s", (path) => {
    expect(matchesImplementProtectedPath(path)).toBe(true);
  });

  test.each(EXACT)("FORBIDDEN_EXACT_PATHS lists %s", (path) => {
    expect(FORBIDDEN_EXACT_PATHS).toContain(path);
  });

  test.each(EXACT)("IMPLEMENT_PROTECTED_EXACT_PATHS lists %s", (path) => {
    expect(IMPLEMENT_PROTECTED_EXACT_PATHS).toContain(path);
  });

  test.each(PROTECTED)(
    "%s is protected even when the leading ./ is kept",
    (path) => {
      expect(matchesForbiddenPath(`./${path}`)).toBe(true);
    },
  );

  test("protects the flow directory by prefix so that inline modules are covered", () => {
    expect(FORBIDDEN_PATH_PREFIXES).toContain("f/factory/dependabot__flow/");
  });

  test.each(CLIENT_LOCKS)(
    "matchesForbiddenPath does not match %s, which pins windmill-client and changes with every bump",
    (path) => {
      expect(matchesForbiddenPath(path)).toBe(false);
    },
  );

  test.each(CLIENT_LOCKS)(
    "matchesImplementProtectedPath does not match %s, which pins windmill-client and changes with every bump",
    (path) => {
      expect(matchesImplementProtectedPath(path)).toBe(false);
    },
  );

  test.each(CLIENT_LOCKS)("FORBIDDEN_EXACT_PATHS does not list %s", (path) => {
    expect(FORBIDDEN_EXACT_PATHS).not.toContain(path);
  });

  test.each(NEAR_MISSES)(
    "matchesForbiddenPath does not match the near miss %s, so the protection is not a loose match",
    (path) => {
      expect(matchesForbiddenPath(path)).toBe(false);
    },
  );

  test.each(NEAR_MISSES)(
    "matchesImplementProtectedPath does not match the near miss %s, so the protection is not a loose match",
    (path) => {
      expect(matchesImplementProtectedPath(path)).toBe(false);
    },
  );

  test("does not protect the shared GitHub module", () => {
    expect(matchesForbiddenPath("f/factory/lib/github.ts")).toBe(false);
  });
});

// `f/factory/`に置かれたdependabotのファイルが保護から漏れないよう、実際のファイルを調べる。
// 後から足すファイルも、この検査に自動で入る。
// 窓口のscriptとステップのlockは`windmill-client`を含み、その版更新で書き換わるので除く。
// libの依存の無いlockも、保護しないので除く。
describe("dependabot files on disk", () => {
  const UNPROTECTED_LOCK =
    /^f\/factory\/(poll_dependabot|steps\/dependabot_[a-z_]+|lib\/dependabot_[a-z_]+)\.script\.lock$/;

  async function dependabotPaths(): Promise<string[]> {
    const paths: string[] = [];
    for await (const path of new Bun.Glob("f/factory/**/*").scan({
      cwd: ".",
      onlyFiles: true,
    })) {
      if (path.includes("dependabot")) paths.push(path);
    }
    return paths;
  }

  test("finds the dependabot files, so that the checks below are not empty", async () => {
    expect(await dependabotPaths()).toContain(
      "f/factory/lib/dependabot_support.ts",
    );
  });

  test("matchesForbiddenPath matches every one except the unprotected locks", async () => {
    const unprotected = (await dependabotPaths()).filter(
      (path) => !UNPROTECTED_LOCK.test(path) && !matchesForbiddenPath(path),
    );
    expect(unprotected).toEqual([]);
  });

  test("matchesImplementProtectedPath matches every one except the unprotected locks", async () => {
    const unprotected = (await dependabotPaths()).filter(
      (path) =>
        !UNPROTECTED_LOCK.test(path) && !matchesImplementProtectedPath(path),
    );
    expect(unprotected).toEqual([]);
  });
});

// ホストの実行役が実行する道具は、pr_fixの自動修正が書き換えられず、implementのPRに記録される。
// 変更を人に通す仕組みは実行役の承認で、保護パスはその補助である。
describe("files that the host executor runs", () => {
  const EXACT = [
    "scripts/host-apply.ts",
    "scripts/host-apply.sh",
    "scripts/host-install.sh",
    "scripts/check-docker-version.sh",
    "scripts/doctor.sh",
    "scripts/bootstrap.sh",
    "scripts/custom-tags.ts",
    "scripts/record-host-applied.sh",
    "scripts/check-idle.ts",
    "tests/scripts/check-idle.test.ts",
    "infra/docker-compose.yml",
    "tests/infra/docker_compose.test.ts",
    "tests/fixtures/host_apply_repo.ts",
  ];
  const UNDER_PREFIX = [
    "scripts/host_apply/ci.ts",
    "scripts/host_apply/deep/nested.ts",
    "infra/worker/Dockerfile",
    "infra/worker/scripts/entry.sh",
    "mise/config.toml",
    "mise/conf.d/extra.toml",
  ];
  const BASENAMES = [
    ".tool-versions",
    "sub/dir/.tool-versions",
    ".env",
    ".env.local",
    ".env.production",
    "sub/.env",
    ".node-version",
    ".bun-version",
    "sub/.bun-version",
  ];
  const HOST_TESTS = [
    "target",
    "imports",
    "ci",
    "approval",
    "mise_policy",
    "env",
    "compose_policy",
    "dryrun",
    "git",
    "state",
    "notify_text",
    "mask",
    "timeouts",
    "plan",
    "package_policy",
    "staging",
    "drain",
    "converge",
    "restore",
    "marker",
    "lock",
    "heartbeat",
    "manifest",
    "notify",
    "approved_store",
    "approve",
    "approved_io",
    "code_origin",
    "approve_cli",
    "secure_file",
    "drain_store",
    "state_io",
    "command",
    "git_grammar",
    "spawn_runner",
    "run_git",
    "run_fetch",
    "host_probe",
    "compose_tables",
  ].map((name) => `tests/scripts/host_apply_${name}.test.ts`);

  test.each([...EXACT, ...UNDER_PREFIX, ...BASENAMES, ...HOST_TESTS])(
    "matchesForbiddenPath matches %s",
    (path) => {
      expect(matchesForbiddenPath(path)).toBe(true);
    },
  );

  test.each([...EXACT, ...UNDER_PREFIX, ...BASENAMES, ...HOST_TESTS])(
    "matchesImplementProtectedPath matches %s",
    (path) => {
      expect(matchesImplementProtectedPath(path)).toBe(true);
    },
  );

  test("the pr_fix and implement lists agree on every one of them", () => {
    const paths = [...EXACT, ...UNDER_PREFIX, ...BASENAMES, ...HOST_TESTS];
    expect(
      paths.filter(
        (path) =>
          matchesForbiddenPath(path) !== matchesImplementProtectedPath(path),
      ),
    ).toEqual([]);
  });

  test.each([
    "docs/env.md",
    "scripts/environment.ts",
    ".environment",
    "infra/workers/x.yml",
    "infra/worker.md",
    "mises/config.toml",
    "scripts/host_apply.md",
    "scripts/doctor.sh.bak",
    "tests/scripts/host_apply_unlisted.test.ts",
    "tests/scripts/other_apply_plan.test.ts",
  ])("matchesForbiddenPath does not match %s", (path) => {
    expect(matchesForbiddenPath(path)).toBe(false);
  });

  test("keeps package.json out of the pr_fix list, as the implement list holds it", () => {
    expect([
      matchesForbiddenPath("package.json"),
      matchesImplementProtectedPath("package.json"),
    ]).toEqual([false, true]);
  });

  test("the implement basename list does not repeat a pattern", () => {
    const sources = IMPLEMENT_PROTECTED_BASENAME_PATTERNS.map((p) => p.source);
    expect(sources.length - new Set(sources).size).toBe(0);
  });

  test("the implement exact list does not repeat a path", () => {
    expect(
      IMPLEMENT_PROTECTED_EXACT_PATHS.length -
        new Set(IMPLEMENT_PROTECTED_EXACT_PATHS).size,
    ).toBe(0);
  });

  test("the pr_fix exact list does not repeat a path", () => {
    expect(
      FORBIDDEN_EXACT_PATHS.length - new Set(FORBIDDEN_EXACT_PATHS).size,
    ).toBe(0);
  });
});

// 実行役のファイルが増えても、保護から漏れないよう、実際のファイルを調べる。
describe("host executor files on disk", () => {
  async function paths(pattern: string): Promise<string[]> {
    const found: string[] = [];
    for await (const path of new Bun.Glob(pattern).scan({
      cwd: ".",
      onlyFiles: true,
    })) {
      found.push(path);
    }
    return found;
  }

  test("finds the executor files, so that the checks below are not empty", async () => {
    expect(await paths("scripts/host_apply/*.ts")).toContain(
      "scripts/host_apply/plan.ts",
    );
  });

  test("matchesForbiddenPath matches every file under scripts/host_apply/", async () => {
    const unprotected = (await paths("scripts/host_apply/**/*")).filter(
      (path) => !matchesForbiddenPath(path),
    );
    expect(unprotected).toEqual([]);
  });

  test("matchesImplementProtectedPath matches every file under scripts/host_apply/", async () => {
    const unprotected = (await paths("scripts/host_apply/**/*")).filter(
      (path) => !matchesImplementProtectedPath(path),
    );
    expect(unprotected).toEqual([]);
  });

  test("matchesForbiddenPath matches every tests/scripts/host_apply_*.test.ts", async () => {
    const unprotected = (
      await paths("tests/scripts/host_apply_*.test.ts")
    ).filter((path) => !matchesForbiddenPath(path));
    expect(unprotected).toEqual([]);
  });

  test("matchesImplementProtectedPath matches every tests/scripts/host_apply_*.test.ts", async () => {
    const unprotected = (
      await paths("tests/scripts/host_apply_*.test.ts")
    ).filter((path) => !matchesImplementProtectedPath(path));
    expect(unprotected).toEqual([]);
  });

  test("matchesForbiddenPath matches every scripts/host-apply.* entry point", async () => {
    const unprotected = (await paths("scripts/host-apply.*")).filter(
      (path) => !matchesForbiddenPath(path),
    );
    expect(unprotected).toEqual([]);
  });

  test("finds the entry point, so that the check above is not empty", async () => {
    expect(await paths("scripts/host-apply.*")).toContain(
      "scripts/host-apply.ts",
    );
  });
});

// 大文字小文字とUnicodeの別名は、ホストのファイルシステムで同じファイルに潰れうる。
describe("aliases that fold to a protected path", () => {
  test("matchesForbiddenPath matches an exact path that differs only in case", () => {
    expect(matchesForbiddenPath("Scripts/Doctor.sh")).toBe(true);
  });

  test("matchesForbiddenPath matches a directory prefix that differs only in case", () => {
    expect(matchesForbiddenPath(".Claude/settings.json")).toBe(true);
  });

  test("matchesForbiddenPath matches the directory name itself in another case", () => {
    expect(matchesForbiddenPath(".GITHUB/Workflows")).toBe(true);
  });

  test("matchesForbiddenPath matches a basename pattern in another case", () => {
    expect(matchesForbiddenPath("sub/Bunfig.toml")).toBe(true);
  });

  test("matchesForbiddenPath matches a long s that folds to s", () => {
    expect(matchesForbiddenPath("ſcripts/doctor.sh")).toBe(true);
  });

  test("matchesForbiddenPath matches a Kelvin sign that folds to k", () => {
    expect(matchesForbiddenPath("infra/docKer-compose.yml")).toBe(true);
  });

  test("matchesForbiddenPath matches a fullwidth alias of a protected directory", () => {
    expect(matchesForbiddenPath("．claude/settings.json")).toBe(true);
  });

  test("matchesForbiddenPath matches a path with a zero-width character inserted", () => {
    expect(matchesForbiddenPath("scripts/doc​tor.sh")).toBe(true);
  });

  test("matchesImplementProtectedPath matches an exact path that differs only in case", () => {
    expect(matchesImplementProtectedPath("Scripts/Doctor.sh")).toBe(true);
  });

  test("matchesImplementProtectedPath matches an implement-only prefix in another case", () => {
    expect(
      matchesImplementProtectedPath("Infra/docker-compose.override.yml"),
    ).toBe(true);
  });

  test("matchesImplementProtectedPath matches a basename pattern with uppercase letters in another case", () => {
    expect(matchesImplementProtectedPath("sub/MAKEFILE")).toBe(true);
  });

  test("matchesImplementProtectedPath matches a long s alias", () => {
    expect(matchesImplementProtectedPath("ſcripts/doctor.sh")).toBe(true);
  });

  test("matchesForbiddenPath matches a capital sharp s that folds to ss", () => {
    expect(matchesForbiddenPath("f/factory/steps/dependabot_aẞeẞ.ts")).toBe(
      true,
    );
  });

  test("matchesForbiddenPath matches a name whose slash only appears after normalization", () => {
    expect(matchesForbiddenPath("sub/.env.℀")).toBe(true);
  });

  test("matchesImplementProtectedPath matches a name that composes into another character", () => {
    expect(matchesImplementProtectedPath("sub/requirementś.txt")).toBe(true);
  });

  test("foldPath is idempotent for every code point", () => {
    const unstable: number[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const once = foldPath(`a${String.fromCodePoint(cp)}b`);
      if (foldPath(once) !== once) unstable.push(cp);
    }
    expect(unstable).toEqual([]);
  });

  test("matchesForbiddenPath still rejects an unrelated path", () => {
    expect(matchesForbiddenPath("docs/Readme.md")).toBe(false);
  });
});

// 依存の無いlibのlockは保護しない。libは`main`を持たず、単独のjobとして動かない。
// libをimportする側のscriptは、自分の`.ts`と`.script.lock`で動く。
// libの`.ts`と`.script.yaml`(`lock`の参照先をlib自身のlockに固定する)は保護したままにする。
describe("dependency-free lib locks", () => {
  const LIBS = [
    "drawio_viewer_bump",
    "drawio_viewer_bump_github",
    "dependabot_support",
    "dependabot_prompt",
    "dependabot_registry",
    "dependabot_collect",
    "dependabot_flow_support",
    "metadata_patch_zip",
    "metadata_patch_yaml",
    "metadata_patch_verify",
    "metadata_patch_imports",
    "metadata_patch_download",
    "metadata_hash",
    "metadata_precheck",
    "metadata_signature",
    "metadata_git_ports",
    "ci_metadata_rehash",
  ].map((name) => `f/factory/lib/${name}`);
  const LOCKS = LIBS.map((base) => `${base}.script.lock`);

  test.each(LOCKS)("matchesForbiddenPath does not match %s", (path) => {
    expect(matchesForbiddenPath(path)).toBe(false);
  });

  test.each(LOCKS)(
    "matchesImplementProtectedPath does not match %s",
    (path) => {
      expect(matchesImplementProtectedPath(path)).toBe(false);
    },
  );

  test.each(LOCKS)("FORBIDDEN_EXACT_PATHS does not list %s", (path) => {
    expect(FORBIDDEN_EXACT_PATHS).not.toContain(path);
  });

  test.each(LOCKS)("the CI round still denies %s", (path) => {
    expect(isDeniedPath(path)).toBe(true);
  });

  test.each(LOCKS)("%s is byte-identical to the empty lock", async (path) => {
    expect(await Bun.file(path).text()).toBe(
      await Bun.file(EMPTY_LOCK_REFERENCE).text(),
    );
  });

  test.each(LIBS)("matchesForbiddenPath keeps matching %s.ts", (base) => {
    expect(matchesForbiddenPath(`${base}.ts`)).toBe(true);
  });

  test.each(LIBS)(
    "matchesImplementProtectedPath keeps matching %s.script.yaml, which fixes the lock reference",
    (base) => {
      expect(matchesImplementProtectedPath(`${base}.script.yaml`)).toBe(true);
    },
  );

  test.each(LIBS)(
    "%s.script.yaml points at the lib's own lock",
    async (base) => {
      expect(await Bun.file(`${base}.script.yaml`).text()).toContain(
        `lock: '!inline ${base}.script.lock'`,
      );
    },
  );

  test("the empty lock that the metadata patch check compares against stays protected", () => {
    expect(matchesForbiddenPath(EMPTY_LOCK_REFERENCE)).toBe(true);
  });

  test("the empty lock that the metadata patch check compares against stays protected for implement", () => {
    expect(matchesImplementProtectedPath(EMPTY_LOCK_REFERENCE)).toBe(true);
  });
});

// libが単独で動く入口(`main`、`preprocessor`、行頭の`export default`、再export)を持たないことを確かめる。
// lockを保護しない前提がこの形に依存するので、崩れたら失敗させる。
function exposesEntryPoint(code: string): boolean {
  const result = readSourceShape(code);
  if (!result.ok) return true;
  if (result.shape.main !== null || result.shape.preprocessor !== null) {
    return true;
  }
  return (
    /^\s*export\s+(default\b|\*|\{[^}]*\}\s*from\b)/m.test(code) ||
    /\bexport\s*\{[^}]*\bas\s+(default|["']main["'])/.test(code)
  );
}

describe("entry point detection of the libs", () => {
  test.each([
    ["export function main", "export async function main(a: string) {}"],
    ["export function preprocessor", "export function preprocessor() {}"],
    ["export const main", "export const main = () => 1;"],
    ["aliased export", "const run = () => 1;\nexport { run as main };"],
    ["default export", "export default function () {}"],
    ["star re-export", 'export * from "./x.ts";'],
    ["named re-export", 'export { main } from "./x.ts";'],
    ["aliased default export", "const run = 1;\nexport { run as default };"],
    ["string export name", 'const run = 1;\nexport { run as "main" };'],
  ])("detects %s", (_label, code) => {
    expect(exposesEntryPoint(code)).toBe(true);
  });

  test.each([
    [
      "a comment that mentions export const main",
      "// export const main\nexport const a = 1;",
    ],
    [
      "a string that mentions export default",
      'export const a = "export default x";',
    ],
    ["a name that starts with main", "export function maintainerNames() {}"],
  ])("does not detect %s", (_label, code) => {
    expect(exposesEntryPoint(code)).toBe(false);
  });
});

describe("libs whose lock is not protected", () => {
  const libs = FORBIDDEN_EXACT_PATHS.filter(
    (path) =>
      /^f\/factory\/lib\/[a-z0-9_]+\.ts$/.test(path) &&
      !FORBIDDEN_EXACT_PATHS.includes(path.replace(/\.ts$/, ".script.lock")),
  );

  test("finds the libs, so that the checks below are not empty", () => {
    expect(libs.length).toBeGreaterThanOrEqual(18);
  });

  test.each(libs)("%s has no entry point", async (path) => {
    expect(exposesEntryPoint(await Bun.file(path).text())).toBe(false);
  });
});

describe("wmill.yaml", () => {
  test("FORBIDDEN_EXACT_PATHS lists it", () => {
    expect(FORBIDDEN_EXACT_PATHS).toContain("wmill.yaml");
  });

  test("matchesForbiddenPath matches it", () => {
    expect(matchesForbiddenPath("wmill.yaml")).toBe(true);
  });

  test("matchesImplementProtectedPath matches it", () => {
    expect(matchesImplementProtectedPath("wmill.yaml")).toBe(true);
  });

  test("matchesForbiddenPath matches it written with a leading ./", () => {
    expect(matchesForbiddenPath("./wmill.yaml")).toBe(true);
  });

  test("FORBIDDEN_EXACT_PATHS does not list wmill-lock.yaml, which changes with every dependency bump", () => {
    expect(FORBIDDEN_EXACT_PATHS).not.toContain("wmill-lock.yaml");
  });
});

const MATCHERS: readonly (readonly [string, (path: string) => boolean])[] = [
  ["matchesForbiddenPath", (path) => matchesForbiddenPath(path)],
  ["matchesImplementProtectedPath", matchesImplementProtectedPath],
];

// wmillの設定は、サブディレクトリに置かれたものも、別名(`wmill.yml`)も止める。
// `wmill-lock.yaml`は依存の変更のたびに書き換わるので、止めない。
describe.each(MATCHERS)("%s and the wmill config", (_name, matches) => {
  test("blocks wmill.yaml in a subdirectory", () => {
    expect(matches("sub/dir/wmill.yaml")).toBe(true);
  });

  test("blocks wmill.yml", () => {
    expect(matches("wmill.yml")).toBe(true);
  });

  test("blocks wmill.yml in a subdirectory", () => {
    expect(matches("sub/wmill.yml")).toBe(true);
  });

  test("does not block wmill-lock.yaml", () => {
    expect(matches("wmill-lock.yaml")).toBe(false);
  });

  test("does not block f/x/wmill-lock.yaml", () => {
    expect(matches("f/x/wmill-lock.yaml")).toBe(false);
  });

  test("does not block wmill.yaml.bak", () => {
    expect(matches("wmill.yaml.bak")).toBe(false);
  });
});

// `bunfig.toml`の`preload`が全テストの前に読み込むファイルで、書き換えられるとテストの前にコードが走る。
describe.each(MATCHERS)("%s and tests/preload.ts", (_name, matches) => {
  test("blocks tests/preload.ts", () => {
    expect(matches("tests/preload.ts")).toBe(true);
  });

  test("does not block tests/lib/other.test.ts", () => {
    expect(matches("tests/lib/other.test.ts")).toBe(false);
  });
});

describe("tests/preload.ts as an exact path", () => {
  test("FORBIDDEN_EXACT_PATHS lists it", () => {
    expect(FORBIDDEN_EXACT_PATHS).toContain("tests/preload.ts");
  });
});

// pr_fixのClaudeに渡す表は、種類ごとの代表例である。保護パスの全体はprotected_paths.tsが持つ。
describe("the factory-fix table of protected files", () => {
  const skill = readFileSync(
    new URL("../../.claude/skills/factory-fix/SKILL.md", import.meta.url),
    "utf8",
  );

  test("the factory-fix table lists wmill.yaml in the file name row", () => {
    const row = skill
      .split("\n")
      .find((line) => line.startsWith("| ファイル名(どのディレクトリでも) |"));
    expect(row).toContain("`wmill.yaml`");
  });

  test("the table says it is a set of examples", () => {
    expect(skill).toMatch(
      /表は種類ごとの代表例で、正確な一覧は.*`f\/factory\/lib\/protected_paths\.ts`が持つ/,
    );
  });
});
