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
    expect(decideChecks([])).toEqual({ docs: [], console: false, test: false });
  });
});
