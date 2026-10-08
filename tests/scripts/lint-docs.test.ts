import { describe, expect, test } from "bun:test";
import {
  blankFrontmatter,
  isTargetDoc,
  lintDocText,
  toToolPath,
} from "../../scripts/lint-docs.ts";

describe("isTargetDoc", () => {
  test.each([
    ["README.md", true],
    ["docs/operations.md", true],
    [".claude/skills/factory-fix/SKILL.md", true],
    [".claude/skills/windmill-script/SKILL.md", true],
    [".claude/skills/review-loop/SKILL.md", true],
    [".claude/agents/implementer.md", true],
    [".claude/agents/notes/draft.md", false],
    [".claude/skills/factory-requirements/template.md", false],
    [".claude/skills/write-script-bun/SKILL.md", false],
    [".claude/skills/yomiyasu/SKILL.md", false],
    [".agents/skills/write-flow/SKILL.md", false],
    ["AGENTS.wmill.md", false],
    ["f/factory/factory_console__raw_app/AGENTS.md", false],
    ["tests/fixtures/audit/valid.md", false],
    ["docs/notes.txt", false],
  ])("%s -> %p", (path, expected) => {
    expect(isTargetDoc(path)).toBe(expected);
  });
});

describe("blankFrontmatter", () => {
  test("keeps the line count while blanking the frontmatter", () => {
    const result = blankFrontmatter("---\nname: a\n---\n# 本文\n");

    expect(result).toBe("\n\n\n# 本文\n");
  });
});

describe("lintDocText", () => {
  test("reports the path, line, and rule of each issue", () => {
    const problems = lintDocText("docs/a.md", "# 見出し\n\n再実行します。\n");

    expect(problems[0]).toStartWith("docs/a.md:3: [register] ");
  });
});

describe("toToolPath", () => {
  test("prefixes a relative path so that a leading dash is not read as an option", () => {
    expect(toToolPath("--fix.md")).toBe("./--fix.md");
  });

  test("leaves a path that already starts with ./ unchanged", () => {
    expect(toToolPath("./docs/a.md")).toBe("./docs/a.md");
  });

  test("leaves an absolute path unchanged", () => {
    expect(toToolPath("/repo/docs/a.md")).toBe("/repo/docs/a.md");
  });
});
