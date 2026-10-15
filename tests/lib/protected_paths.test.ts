import { describe, expect, test } from "bun:test";
import {
  FORBIDDEN_EXACT_PATHS,
  FORBIDDEN_PATH_PREFIXES,
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

  test("matches the lock of the library that rewrites the viewer pin", () => {
    expect(
      matchesForbiddenPath("f/factory/lib/drawio_viewer_bump.script.lock"),
    ).toBe(true);
  });

  test("matches the script definition of the library that rewrites the viewer pin", () => {
    expect(
      matchesForbiddenPath("f/factory/lib/drawio_viewer_bump.script.yaml"),
    ).toBe(true);
  });

  test("matches the lock of the GitHub module of the viewer pin update", () => {
    expect(
      matchesForbiddenPath(
        "f/factory/lib/drawio_viewer_bump_github.script.lock",
      ),
    ).toBe(true);
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

// メタデータのパッチを検査する部品は、書き換えられると、受け取り側の検査が緩む。
// 保護が完全一致の一覧から来ていることを確かめる。
describe("metadata patch manifest files", () => {
  const EXACT = [
    "f/factory/lib/metadata_patch_manifest.ts",
    "f/factory/lib/metadata_patch_manifest.script.yaml",
    "f/factory/lib/metadata_patch_manifest.script.lock",
    "f/factory/lib/metadata_patch_zip.ts",
    "f/factory/lib/metadata_patch_zip.script.yaml",
    "f/factory/lib/metadata_patch_zip.script.lock",
    "f/factory/lib/metadata_patch_yaml.ts",
    "f/factory/lib/metadata_patch_yaml.script.yaml",
    "f/factory/lib/metadata_patch_yaml.script.lock",
    "f/factory/lib/metadata_patch_verify.ts",
    "f/factory/lib/metadata_patch_verify.script.yaml",
    "f/factory/lib/metadata_patch_verify.script.lock",
    "f/factory/lib/metadata_patch_imports.ts",
    "f/factory/lib/metadata_patch_imports.script.yaml",
    "f/factory/lib/metadata_patch_imports.script.lock",
    "f/factory/lib/metadata_patch_download.ts",
    "f/factory/lib/metadata_patch_download.script.yaml",
    "f/factory/lib/metadata_patch_download.script.lock",
    "f/factory/lib/metadata_hash.ts",
    "f/factory/lib/metadata_hash.script.yaml",
    "f/factory/lib/metadata_hash.script.lock",
    "f/factory/lib/metadata_precheck.ts",
    "f/factory/lib/metadata_precheck.script.yaml",
    "f/factory/lib/metadata_precheck.script.lock",
    "f/factory/lib/metadata_signature.ts",
    "f/factory/lib/metadata_signature.script.yaml",
    "f/factory/lib/metadata_signature.script.lock",
    "f/factory/lib/metadata_git_ports.ts",
    "f/factory/lib/metadata_git_ports.script.yaml",
    "f/factory/lib/metadata_git_ports.script.lock",
    "f/factory/lib/ci_metadata_rehash.ts",
    "f/factory/lib/ci_metadata_rehash.script.yaml",
    "f/factory/lib/ci_metadata_rehash.script.lock",
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
  // 依存の無いlib。lockは`"dependencies": {}`で、`windmill-client`の版更新で書き換わらない。
  const LIB_LOCKS = SCRIPTS.filter((base) =>
    base.startsWith("f/factory/lib/"),
  ).map((base) => `${base}.script.lock`);
  // 窓口のscriptとステップのlockは`windmill-client`を含み、その版更新で書き換わる。
  const CLIENT_LOCKS = SCRIPTS.filter(
    (base) => !base.startsWith("f/factory/lib/"),
  ).map((base) => `${base}.script.lock`);
  const EXACT = [
    ...SCRIPTS.flatMap((base) => [`${base}.ts`, `${base}.script.yaml`]),
    ...LIB_LOCKS,
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

  test.each(LIB_LOCKS)(
    "the lock %s does not pin windmill-client, so it does not change with a bump",
    async (path) => {
      expect(await Bun.file(path).text()).not.toContain("windmill-client");
    },
  );

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
describe("dependabot files on disk", () => {
  const CLIENT_LOCK =
    /^f\/factory\/(poll_dependabot|steps\/dependabot_[a-z_]+)\.script\.lock$/;

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

  test("matchesForbiddenPath matches every one except the locks that pin windmill-client", async () => {
    const unprotected = (await dependabotPaths()).filter(
      (path) => !CLIENT_LOCK.test(path) && !matchesForbiddenPath(path),
    );
    expect(unprotected).toEqual([]);
  });

  test("matchesImplementProtectedPath matches every one except the locks that pin windmill-client", async () => {
    const unprotected = (await dependabotPaths()).filter(
      (path) => !CLIENT_LOCK.test(path) && !matchesImplementProtectedPath(path),
    );
    expect(unprotected).toEqual([]);
  });
});
