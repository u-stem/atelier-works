import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  collectMarkdownTests,
  decideChecks,
  type GitGrep,
  planTestCommands,
} from "../../scripts/check-changed.ts";

describe("decideChecks", () => {
  test("changed Markdown files are passed to the docs lint", () => {
    expect(decideChecks(["docs/setup.md", "f/factory/lib/a.ts"]).docs).toEqual([
      "docs/setup.md",
    ]);
  });

  test("no Markdown change leaves the docs list empty", () => {
    expect(decideChecks(["f/factory/lib/a.ts"]).docs).toEqual([]);
  });

  test("a change under console/ runs the console check", () => {
    expect(decideChecks(["console/src/App.tsx"]).console).toBe(true);
  });

  test("a change to the shared lib runs the console check", () => {
    expect(decideChecks(["f/factory/lib/approval_support.ts"]).console).toBe(
      true,
    );
  });

  test("a root config change runs the console check", () => {
    expect(decideChecks(["bun.lock"]).console).toBe(true);
  });

  test("a document-only change skips the console check", () => {
    expect(decideChecks(["docs/setup.md"]).console).toBe(false);
  });

  test("a document-only change skips the test run", () => {
    expect(decideChecks(["docs/setup.md"]).test).toBe(false);
  });

  test("a code change runs the test run", () => {
    expect(decideChecks(["scripts/freeze.ts"]).test).toBe(true);
  });

  test("an empty diff skips everything", () => {
    expect(decideChecks([])).toEqual({
      docs: [],
      deletedDocs: [],
      console: false,
      test: false,
      fullTest: false,
    });
  });

  test.each([
    ["a shell script", "scripts/worktree-new.sh"],
    ["a YAML file", "f/factory/flows/a.flow/flow.yaml"],
    ["a .yml file", ".github/workflows/ci.yml"],
    ["package.json", "package.json"],
    ["bun.lock", "bun.lock"],
    ["tsconfig.json", "tsconfig.json"],
    ["a tsconfig variant", "tsconfig.build.json"],
    ["mise.toml", "mise.toml"],
    ["lefthook.yml", "lefthook.yml"],
    ["biome.json", "biome.json"],
    ["biome.jsonc", "biome.jsonc"],
    ["bunfig.toml", "bunfig.toml"],
    ["a SQL migration", "migrations/datatable/main/001_x.sql"],
    ["a Caddyfile", "infra/Caddyfile"],
    ["a Dockerfile", "infra/worker/Dockerfile"],
    ["a JSON setting under .claude", ".claude/settings.json"],
    ["a file without an extension", "scripts/hooks/pre-push"],
  ])("a change to %s runs the full test run", (_label, path) => {
    expect(decideChecks([path]).fullTest).toBe(true);
  });

  test.each([
    ["wmill-lock.yaml", "wmill-lock.yaml"],
    ["a script schema", "f/factory/a.script.yaml"],
    ["a script lock", "f/factory/a.script.lock"],
  ])("a change to %s alone runs the full test run", (_label, path) => {
    expect(decideChecks([path]).fullTest).toBe(true);
  });

  test("a script schema with its own TypeScript file keeps the selective test run", () => {
    expect(
      decideChecks(["f/factory/a.script.yaml", "f/factory/a.ts"]).fullTest,
    ).toBe(false);
  });

  test("a script lock with its own TypeScript file keeps the selective test run", () => {
    expect(
      decideChecks(["f/factory/a.script.lock", "f/factory/a.ts"]).fullTest,
    ).toBe(false);
  });

  test("a script schema with another TypeScript file runs the full test run", () => {
    expect(
      decideChecks(["f/factory/a.script.yaml", "f/factory/b.ts"]).fullTest,
    ).toBe(true);
  });

  test("wmill-lock.yaml with a TypeScript file under f/ keeps the selective test run", () => {
    expect(decideChecks(["wmill-lock.yaml", "f/factory/a.ts"]).fullTest).toBe(
      false,
    );
  });

  test("wmill-lock.yaml with a TypeScript file outside f/ runs the full test run", () => {
    expect(decideChecks(["wmill-lock.yaml", "scripts/x.ts"]).fullTest).toBe(
      true,
    );
  });

  test("generated metadata together with a shell script runs the full test run", () => {
    expect(
      decideChecks([
        "f/factory/a.script.lock",
        "f/factory/a.ts",
        "scripts/a.sh",
      ]).fullTest,
    ).toBe(true);
  });

  test.each([
    ["a TSX file", "console/src/App.tsx"],
    ["the lockfile", "console/bun.lock"],
    ["a shell script", "console/scripts/build.sh"],
  ])(
    "a change to %s under console/ does not run the full test run",
    (_label, path) => {
      expect(decideChecks([path]).fullTest).toBe(false);
    },
  );

  test("a deleted SQL file runs the full test run", () => {
    expect(
      decideChecks([], ["migrations/datatable/main/001_x.sql"]).fullTest,
    ).toBe(true);
  });

  test("a deleted script lock with its changed TypeScript file keeps the selective test run", () => {
    expect(
      decideChecks(["f/factory/a.ts"], ["f/factory/a.script.lock"]).fullTest,
    ).toBe(false);
  });

  test("a deleted script lock with its deleted TypeScript file runs the full test run", () => {
    expect(
      decideChecks([], ["f/factory/a.script.lock", "f/factory/a.ts"]).fullTest,
    ).toBe(true);
  });

  test("a deleted script lock alone runs the full test run", () => {
    expect(decideChecks([], ["f/factory/a.script.lock"]).fullTest).toBe(true);
  });

  test("a deleted TypeScript file runs the test run", () => {
    expect(decideChecks([], ["scripts/old.ts"]).test).toBe(true);
  });

  test("a deleted file under console/ runs the console check", () => {
    expect(decideChecks([], ["console/src/Old.tsx"]).console).toBe(true);
  });

  test("a deleted Markdown file does not run the test run", () => {
    expect(decideChecks([], ["docs/old.md"]).test).toBe(false);
  });

  test("a deleted Markdown file is kept for the test collection", () => {
    expect(decideChecks([], ["docs/old.md"]).deletedDocs).toEqual([
      "docs/old.md",
    ]);
  });

  test("a deleted file that is not Markdown stays out of the deleted documents", () => {
    expect(decideChecks([], ["scripts/old.ts"]).deletedDocs).toEqual([]);
  });

  test("a change to a TypeScript file keeps the selective test run", () => {
    expect(decideChecks(["scripts/freeze.ts"]).fullTest).toBe(false);
  });

  test("a document-only change does not run the full test run", () => {
    expect(decideChecks(["docs/setup.md"]).fullTest).toBe(false);
  });

  test("a package.json under console/ does not run the full test run", () => {
    expect(decideChecks(["console/package.json"]).fullTest).toBe(false);
  });

  test("a deleted shell script runs the full test run", () => {
    expect(decideChecks([], ["scripts/old.sh"]).fullTest).toBe(true);
  });

  test("a deleted shell script runs the test run", () => {
    expect(decideChecks([], ["scripts/old.sh"]).test).toBe(true);
  });

  test("a deleted file does not enter the docs list", () => {
    expect(decideChecks([], ["docs/old.md"]).docs).toEqual([]);
  });

  // 削除されたコードは、importのグラフに現れない。消したモジュールをまだ読むテストを選べない。
  test.each([
    ["TypeScript", "scripts/old.ts"],
    ["TSX", "f/factory/old.tsx"],
    ["JavaScript", "scripts/old.js"],
    ["ES module JavaScript", "scripts/old.mjs"],
  ])("a deleted %s file runs the full test run", (_label, path) => {
    expect(decideChecks([], [path]).fullTest).toBe(true);
  });

  test("a deleted Markdown file does not run the full test run", () => {
    expect(decideChecks([], ["docs/old.md"]).fullTest).toBe(false);
  });

  test("a deleted TypeScript file under console/ does not run the full test run", () => {
    expect(decideChecks([], ["console/src/old.ts"]).fullTest).toBe(false);
  });

  test("a deleted TypeScript file with a changed one still runs the full test run", () => {
    expect(decideChecks(["scripts/new.ts"], ["scripts/old.ts"]).fullTest).toBe(
      true,
    );
  });
});

describe("collectMarkdownTests", () => {
  // 検索語ごとに決まった結果を返す、gitの呼び出しの代わり。
  const grepFrom =
    (table: Record<string, readonly string[]>): GitGrep =>
    (needle) =>
      table[needle] ?? [];

  // ファイルの存在を確かめる関数の代わり。
  const noFiles = () => false;
  const allFiles = () => true;

  test("collects the test files that write the Markdown path", () => {
    const grep = grepFrom({
      "docs/operations.md": ["tests/lib/console_support.test.ts"],
    });

    expect(collectMarkdownTests(["docs/operations.md"], grep, noFiles)).toEqual(
      ["tests/lib/console_support.test.ts"],
    );
  });

  test("collects the test files that write the skill directory", () => {
    const grep = grepFrom({
      ".claude/skills/factory-fix": ["tests/lib/skill_names.test.ts"],
    });

    expect(
      collectMarkdownTests(
        [".claude/skills/factory-fix/SKILL.md"],
        grep,
        noFiles,
      ),
    ).toEqual(["tests/lib/skill_names.test.ts"]);
  });

  test("returns nothing when no test writes the path", () => {
    expect(
      collectMarkdownTests(["docs/unused.md"], grepFrom({}), noFiles),
    ).toEqual([]);
  });

  test("returns a test file once when several paths find it", () => {
    const grep = grepFrom({
      "docs/a.md": ["tests/lib/x.test.ts"],
      "docs/b.md": ["tests/lib/x.test.ts"],
    });

    expect(
      collectMarkdownTests(["docs/a.md", "docs/b.md"], grep, noFiles),
    ).toEqual(["tests/lib/x.test.ts"]);
  });

  test("keeps only test files", () => {
    const grep = grepFrom({
      "docs/a.md": ["tests/lib/support.ts", "tests/lib/x.test.ts"],
    });

    expect(collectMarkdownTests(["docs/a.md"], grep, noFiles)).toEqual([
      "tests/lib/x.test.ts",
    ]);
  });

  test("adds the tests that read every skill when a skill document changed", () => {
    expect(
      collectMarkdownTests(
        [".claude/skills/hold/SKILL.md"],
        grepFrom({}),
        allFiles,
      ),
    ).toEqual([
      "tests/lib/commit_message_style.test.ts",
      "tests/scripts/claude-config.test.ts",
    ]);
  });

  test("adds the tests that read every skill when a skill document was deleted", () => {
    // 削除されたスキルの文書も、同じ一覧で渡される。
    expect(
      collectMarkdownTests(
        [".claude/skills/old/SKILL.md"],
        grepFrom({}),
        allFiles,
      ),
    ).toHaveLength(2);
  });

  test("does not add a skill-reading test that does not exist", () => {
    const onlyConfig = (path: string) =>
      path === "tests/scripts/claude-config.test.ts";

    expect(
      collectMarkdownTests(
        [".claude/skills/hold/SKILL.md"],
        grepFrom({}),
        onlyConfig,
      ),
    ).toEqual(["tests/scripts/claude-config.test.ts"]);
  });

  test("finds the skill-reading tests at their real paths", () => {
    // 固定の2つのパスが改名されると、黙って外れる。実在することをここで確かめる。
    expect(
      collectMarkdownTests(
        [".claude/skills/hold/SKILL.md"],
        grepFrom({}),
        existsSync,
      ),
    ).toEqual([
      "tests/lib/commit_message_style.test.ts",
      "tests/scripts/claude-config.test.ts",
    ]);
  });

  test("does not add the skill-reading tests for a document outside the skills", () => {
    expect(
      collectMarkdownTests(["docs/setup.md"], grepFrom({}), allFiles),
    ).toEqual([]);
  });
});

describe("planTestCommands", () => {
  const mdTests = ["tests/lib/console_support.test.ts"];
  const base = "0123abc";

  test("runs only the full suite when the plan needs it", () => {
    const commands = planTestCommands(
      { test: true, fullTest: true },
      mdTests,
      base,
    );

    expect(commands).toEqual([["mise", "run", "test:all"]]);
  });

  test("selects tests by the diff from the merge base when the plan has code changes", () => {
    const commands = planTestCommands(
      { test: true, fullTest: false },
      [],
      base,
    );

    expect(commands.map((argv) => argv.includes(`--changed=${base}`))).toEqual([
      true,
    ]);
  });

  test("does not select by origin/main directly", () => {
    const commands = planTestCommands(
      { test: true, fullTest: false },
      [],
      base,
    );

    expect(
      commands.some((argv) => argv.includes("--changed=origin/main")),
    ).toBe(false);
  });

  test("runs the collected Markdown tests when only Markdown changed", () => {
    const commands = planTestCommands(
      { test: false, fullTest: false },
      mdTests,
      base,
    );

    expect(commands.map((argv) => argv.includes(mdTests[0] ?? ""))).toEqual([
      true,
    ]);
  });

  test("does not select by the diff when only Markdown changed", () => {
    const commands = planTestCommands(
      { test: false, fullTest: false },
      mdTests,
      base,
    );

    expect(commands.some((argv) => argv.includes(`--changed=${base}`))).toBe(
      false,
    );
  });

  test("adds the Markdown tests after the diff selection", () => {
    const commands = planTestCommands(
      { test: true, fullTest: false },
      mdTests,
      base,
    );

    expect(commands).toHaveLength(2);
  });

  test("runs nothing when only Markdown changed and no test writes it", () => {
    expect(
      planTestCommands({ test: false, fullTest: false }, [], base),
    ).toEqual([]);
  });
});
