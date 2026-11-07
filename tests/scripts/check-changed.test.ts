import { describe, expect, test } from "bun:test";
import { decideChecks } from "../../scripts/check-changed.ts";

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
  ])("a change to %s runs the full test run", (_label, path) => {
    expect(decideChecks([path]).fullTest).toBe(true);
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

  test("a deleted TypeScript file does not run the full test run", () => {
    expect(decideChecks([], ["scripts/old.ts"]).fullTest).toBe(false);
  });
});
