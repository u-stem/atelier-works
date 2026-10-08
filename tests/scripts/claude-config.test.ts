import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const AGENTS_DIR = join(ROOT, ".claude/agents");
const AGENTS = [
  "implementer",
  "code-reviewer",
  "security-auditor",
  "devil-advocate",
  "doc-writer",
];
const READ_ONLY_AGENTS = [
  "code-reviewer",
  "security-auditor",
  "devil-advocate",
];
const FACTORY_DOCS_PRELOADED = ["implementer", "code-reviewer", "doc-writer"];
const OWNED_DIRS = [".claude/agents", ".claude/skills/review-loop"];
const MODELS = ["sonnet", "opus", "haiku", "fable", "inherit"];
const WRITE_TOOL = /^(Edit|MultiEdit|Write|NotebookEdit)(\(|$)/;

// 外部の設定リポジトリの名前は、このテスト自身が検出されないよう、部品から組み立てる。
const FORBIDDEN = new RegExp(
  [
    "/Users/",
    "/home/[a-z]",
    "~/ws/",
    ["claude", "system"].join("-"),
    "superpowers",
  ].join("|"),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function frontmatter(name: string): Record<string, unknown> {
  const text = readFileSync(join(AGENTS_DIR, `${name}.md`), "utf8");
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
  const parsed: unknown = Bun.YAML.parse(block);
  return isRecord(parsed) ? parsed : {};
}

/** frontmatterの一覧の項目を返す。YAMLの配列とカンマ区切りの文字列のどちらも受け付ける。 */
function listField(name: string, field: string): string[] {
  const value = frontmatter(name)[field];
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim());
  }
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function tools(name: string): string[] {
  return listField(name, "tools");
}

function listFiles(dir: string): string[] {
  const absolute = join(ROOT, dir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { recursive: true })
    .map((entry) => join(dir, String(entry)))
    .filter((path) => statSync(join(ROOT, path)).isFile());
}

describe(".claude/agents", () => {
  test("defines exactly the expected agents", () => {
    expect(readdirSync(AGENTS_DIR).sort()).toEqual(
      AGENTS.map((name) => `${name}.md`).sort(),
    );
  });

  test.each(AGENTS)("names %s after its file", (name) => {
    expect(frontmatter(name).name).toBe(name);
  });

  test.each(AGENTS)("gives %s a description", (name) => {
    expect(typeof frontmatter(name).description).toBe("string");
  });

  test.each(AGENTS)("pins the model of %s to a known value", (name) => {
    const model = frontmatter(name).model;
    expect(typeof model === "string" && MODELS.includes(model)).toBe(true);
  });

  test.each(AGENTS)("lists at least one tool for %s", (name) => {
    expect(tools(name).length).toBeGreaterThan(0);
  });

  test.each(READ_ONLY_AGENTS)("keeps %s free of write tools", (name) => {
    expect(tools(name).filter((tool) => WRITE_TOOL.test(tool))).toEqual([]);
  });

  // Skillが無いsubagentは、yomiyasuやfactory-docsを呼べずに飛ばしてしまう。
  test.each(AGENTS)("lets %s invoke skills", (name) => {
    expect(tools(name)).toContain("Skill");
  });

  test.each(FACTORY_DOCS_PRELOADED)("preloads factory-docs into %s", (name) => {
    expect(listField(name, "skills")).toContain("factory-docs");
  });

  test("preloads yomiyasu into doc-writer", () => {
    expect(listField("doc-writer", "skills")).toContain("yomiyasu");
  });

  test.each(AGENTS)("resolves every skill preloaded into %s", (name) => {
    const missing = listField(name, "skills").filter(
      (skill) => !existsSync(join(ROOT, ".claude/skills", skill, "SKILL.md")),
    );
    expect(missing).toEqual([]);
  });
});

describe("repository-owned Claude config", () => {
  test("contains no machine-specific paths or external config names", () => {
    const offenders = OWNED_DIRS.flatMap(listFiles).filter((path) =>
      FORBIDDEN.test(readFileSync(join(ROOT, path), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  test("ships the review-loop skill", () => {
    expect(existsSync(join(ROOT, ".claude/skills/review-loop/SKILL.md"))).toBe(
      true,
    );
  });
});
