import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  formatDocument,
  main,
} from "../../scripts/format-one-sentence-per-line.ts";
import { findSentenceBreaks } from "../../scripts/lint-one-sentence-per-line.ts";

function formatted(markdown: string): string {
  return formatDocument(markdown).formatted;
}

describe("formatDocument layout", () => {
  test("splits a paragraph after every full stop that has text after it", () => {
    expect(formatted("A。B。C\n")).toBe("A。\nB。\nC\n");
  });

  test("returns a document without violations unchanged", () => {
    expect(formatted("A。\nB。\n")).toBe("A。\nB。\n");
  });

  test("leaves the lines that are not violations alone", () => {
    expect(formatted("A。\n\nB。C\n\n- D。\n")).toBe(
      "A。\n\nB。\nC\n\n- D。\n",
    );
  });

  test("indents the next sentence of a bullet item to the item text", () => {
    expect(formatted("- A。B\n")).toBe("- A。\n  B\n");
  });

  test("indents the next sentence of a numbered item to the item text", () => {
    expect(formatted("1. A。B\n")).toBe("1. A。\n   B\n");
  });

  test("indents the next sentence of a nested item to the nested text", () => {
    expect(formatted("- X。\n  - A。B\n")).toBe("- X。\n  - A。\n    B\n");
  });

  test("indents the next sentence of a task list item to the item text", () => {
    expect(formatted("- [ ] A。B\n")).toBe("- [ ] A。\n  B\n");
  });

  test("keeps the indent of the second paragraph of an item", () => {
    expect(formatted("- X。\n\n  A。B\n")).toBe("- X。\n\n  A。\n  B\n");
  });

  test("marks the next sentence of a block quote with the quote sign", () => {
    expect(formatted("> A。B\n")).toBe("> A。\n> B\n");
  });

  test("marks the next sentence of a quote inside an item", () => {
    expect(formatted("- > A。B\n")).toBe("- > A。\n  > B\n");
  });

  test("splits a violating line in the middle of a paragraph", () => {
    expect(formatted("A。\nB。C\nD。\n")).toBe("A。\nB。\nC\nD。\n");
  });

  test("splits with the line ending the document already uses", () => {
    expect(formatted("A。B\r\nC。\r\n")).toBe("A。\r\nB\r\nC。\r\n");
  });

  test("leaves no violation behind", () => {
    const result = formatted("- A。B。C\n  - D。E\n\n> F。G\n");

    expect(findSentenceBreaks(result)).toEqual([]);
  });
});

describe("formatDocument verification", () => {
  test("reports no problem when the structure is kept", () => {
    expect(formatDocument("- A。B\n").problems).toEqual([]);
  });

  test("reports a problem when the split turns text into a list", () => {
    expect(formatDocument("A。- B\n").problems).not.toEqual([]);
  });

  test("reports a problem when the split turns text into a heading", () => {
    expect(formatDocument("A。# B\n").problems).not.toEqual([]);
  });

  test("returns the original text when the structure would change", () => {
    expect(formatted("A。- B\n")).toBe("A。- B\n");
  });
});

describe("main", () => {
  const dirs: string[] = [];

  function makeRoot(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "format-sentence-"));
    dirs.push(dir);
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), body);
    }
    return dir;
  }

  function run(
    dir: string,
    args: string[],
  ): { exitCode: number; output: string[] } {
    const output: string[] = [];
    const exitCode = main(dir, args, dir, (line) => {
      output.push(line);
    });
    return { exitCode, output };
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
  });

  test("rewrites a file that has a violation", () => {
    const dir = makeRoot({ "docs/a.md": "A。B\n" });

    run(dir, ["docs/a.md"]);

    expect(readFileSync(join(dir, "docs/a.md"), "utf8")).toBe("A。\nB\n");
  });

  test("exits with 0 when every file is formatted", () => {
    const dir = makeRoot({ "docs/a.md": "A。B\n" });

    expect(run(dir, ["docs/a.md"]).exitCode).toBe(0);
  });

  test("does not write a file whose structure would change", () => {
    const dir = makeRoot({ "docs/a.md": "A。- B\n" });

    run(dir, ["docs/a.md"]);

    expect(readFileSync(join(dir, "docs/a.md"), "utf8")).toBe("A。- B\n");
  });

  test("exits with 1 and names the file whose structure would change", () => {
    const dir = makeRoot({ "docs/a.md": "A。- B\n" });

    const { exitCode, output } = run(dir, ["docs/a.md"]);

    expect(exitCode).toBe(1);
    expect(output.join("\n")).toContain("docs/a.md");
  });

  test("still writes the other files when one file fails the check", () => {
    const dir = makeRoot({ "docs/a.md": "A。- B\n", "docs/b.md": "C。D\n" });

    run(dir, ["docs/a.md", "docs/b.md"]);

    expect(readFileSync(join(dir, "docs/b.md"), "utf8")).toBe("C。\nD\n");
  });

  test("leaves a file that the lint does not cover alone", () => {
    const dir = makeRoot({ ".claude/skills/hold/SKILL.md": "A。B\n" });

    run(dir, [".claude/skills/hold/SKILL.md"]);

    expect(
      readFileSync(join(dir, ".claude/skills/hold/SKILL.md"), "utf8"),
    ).toBe("A。B\n");
  });

  test("formats every document of the repository when no file is given", () => {
    const dir = makeRoot({ "docs/a.md": "A。B\n", "docs/b.md": "C。D\n" });
    Bun.spawnSync(["git", "init", "-q"], { cwd: dir });

    run(dir, []);

    expect(readFileSync(join(dir, "docs/b.md"), "utf8")).toBe("C。\nD\n");
  });
});
