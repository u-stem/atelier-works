import { describe, expect, test } from "bun:test";
import {
  DEFAULT_GLOBS,
  findShortRemoteRefs,
  isTargetFile,
} from "../../scripts/lint-no-short-remote-ref.ts";

// 通常の文字列に置換の記号を書くとlintの警告が出るため、組み立てて使う。
const OPEN = "$" + "{";

describe("findShortRemoteRefs", () => {
  test("flags a double-quoted literal that starts with origin/", () => {
    const findings = findShortRemoteRefs("a.ts", 'const ref = "origin/main";');
    expect(findings).toHaveLength(1);
  });

  test("flags a single-quoted literal that starts with origin/", () => {
    const findings = findShortRemoteRefs("a.ts", "const ref = 'origin/HEAD';");
    expect(findings).toHaveLength(1);
  });

  test("flags a template literal without substitutions that starts with origin/", () => {
    const findings = findShortRemoteRefs("a.ts", "const ref = `origin/main`;");
    expect(findings).toHaveLength(1);
  });

  test("flags a template literal whose head starts with origin/", () => {
    const findings = findShortRemoteRefs(
      "a.ts",
      `const ref = \`origin/${OPEN}branch}\`;`,
    );
    expect(findings).toHaveLength(1);
  });

  test("flags a literal inside a call argument list", () => {
    const findings = findShortRemoteRefs(
      "a.ts",
      'run(["rev-parse", "--verify", "origin/HEAD"]);',
    );
    expect(findings).toHaveLength(1);
  });

  test("flags a literal inside a template substitution", () => {
    const findings = findShortRemoteRefs(
      "a.ts",
      `const s = \`x ${OPEN}\`origin/${OPEN}b}\`}\`;`,
    );
    expect(findings).toHaveLength(1);
  });

  test("reports the line and column of the literal", () => {
    const findings = findShortRemoteRefs(
      "a.ts",
      'const a = 1;\nconst ref = "origin/main";\n',
    );
    expect(findings).toEqual([
      {
        file: "a.ts",
        line: 2,
        column: 13,
        message: expect.stringContaining("refs/remotes/origin/"),
      },
    ]);
  });

  test("allows the full remote-tracking name", () => {
    const findings = findShortRemoteRefs(
      "a.ts",
      `const ref = \`refs/remotes/origin/${OPEN}branch}\`;`,
    );
    expect(findings).toEqual([]);
  });

  test("allows the remote name on its own", () => {
    const findings = findShortRemoteRefs("a.ts", 'run(["fetch", "origin"]);');
    expect(findings).toEqual([]);
  });

  test("allows a literal that only contains origin/ in the middle", () => {
    const findings = findShortRemoteRefs(
      "a.ts",
      'const s = "from origin/main";',
    );
    expect(findings).toEqual([]);
  });

  test("allows origin/ in a line comment", () => {
    const findings = findShortRemoteRefs(
      "a.ts",
      "// origin/main is a short name\n",
    );
    expect(findings).toEqual([]);
  });

  test("allows origin/ in a block comment", () => {
    const findings = findShortRemoteRefs(
      "a.ts",
      "/** origin/<branch> */\nconst a = 1;\n",
    );
    expect(findings).toEqual([]);
  });

  test("keeps scanning after a regular expression literal", () => {
    const findings = findShortRemoteRefs(
      "a.ts",
      'const re = /#(\\d+)/;\nconst ref = "origin/main";\n',
    );
    expect(findings).toHaveLength(1);
  });
});

describe("isTargetFile", () => {
  test("targets a TypeScript file under f/factory", () => {
    expect(isTargetFile("f/factory/lib/workspace.ts")).toBe(true);
  });

  test("targets a TypeScript file under f/factory with a leading ./", () => {
    expect(isTargetFile("./f/factory/lib/workspace.ts")).toBe(true);
  });

  test("does not target tests", () => {
    expect(isTargetFile("tests/lib/workspace.test.ts")).toBe(false);
  });

  test("does not target a file outside f/factory", () => {
    expect(isTargetFile("scripts/lint-docs.ts")).toBe(false);
  });

  test("does not target a non-TypeScript file under f/factory", () => {
    expect(isTargetFile("f/factory/lib/workspace.script.yaml")).toBe(false);
  });
});

describe("DEFAULT_GLOBS", () => {
  test("covers the factory TypeScript sources", () => {
    expect(DEFAULT_GLOBS).toEqual(["f/factory/**/*.{ts,tsx}"]);
  });
});
