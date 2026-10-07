import { describe, expect, test } from "bun:test";
import {
  findSectionSigns,
  isTargetFile,
} from "../../scripts/lint-no-section-sign.ts";

// 節記号そのものをこのファイルのソースに書くと、lint自身に検出されるため、
// コードポイントから組み立てる。
const SIGN = String.fromCodePoint(0xa7);

describe("findSectionSigns", () => {
  test("reports the line and column of a section sign", () => {
    const text = `const a = 1;\n// see ${SIGN}2\n`;
    expect(findSectionSigns("a.ts", text)).toEqual([
      {
        file: "a.ts",
        line: 2,
        column: 8,
        message: expect.stringContaining("section sign"),
      },
    ]);
  });

  test("reports a section sign inside a string literal", () => {
    const text = `const s = "${SIGN}";\n`;
    expect(findSectionSigns("a.ts", text)).toHaveLength(1);
  });

  test("reports every occurrence on separate lines", () => {
    const text = `${SIGN}\n\n${SIGN}\n`;
    expect(findSectionSigns("a.sh", text).map((f) => f.line)).toEqual([1, 3]);
  });

  test("reports nothing for a file without a section sign", () => {
    expect(findSectionSigns("a.ts", "const a = 1;\n")).toEqual([]);
  });

  test("counts lines in a CRLF file", () => {
    const text = `a\r\nb ${SIGN}\r\n`;
    expect(findSectionSigns("a.toml", text).map((f) => f.line)).toEqual([2]);
  });
});

describe("isTargetFile", () => {
  test.each([
    "f/factory/a.ts",
    "f/factory/app/x.tsx",
    "a.js",
    "a.mjs",
    "scripts/a.sh",
    "lefthook.yml",
    "f/factory/a.script.yaml",
    "mise.toml",
    "queries/a.sql",
    "infra/Caddyfile",
    "infra/worker/Dockerfile",
  ])("targets %s", (path) => {
    expect(isTargetFile(path)).toBe(true);
  });

  test.each([
    "README.md",
    "docs/a.md",
    "migrations/datatable/main/a.up.sql",
    ".claude/skills/a/SKILL.md",
    ".claude/hooks/a.sh",
    ".agents/skills/a/scripts/a.ts",
    "node_modules/a/index.js",
    "f/factory/app/node_modules/a/index.js",
    "f/factory/a.script.lock",
    "wmill-lock.yaml",
    "tests/fixtures/a.ts",
    "image.png",
    "package.json",
  ])("skips %s", (path) => {
    expect(isTargetFile(path)).toBe(false);
  });

  test("normalizes a leading ./", () => {
    expect(isTargetFile("./migrations/a.sql")).toBe(false);
  });

  test("targets a Dockerfile with a suffix", () => {
    expect(isTargetFile("infra/Dockerfile.dev")).toBe(true);
  });
});
