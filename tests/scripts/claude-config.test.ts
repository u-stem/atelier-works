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
  "requirements-reviewer",
  "design-reviewer",
  "triage",
];
const READ_ONLY_AGENTS = [
  "code-reviewer",
  "security-auditor",
  "devil-advocate",
  "requirements-reviewer",
  "design-reviewer",
  "triage",
];
const FACTORY_DOCS_PRELOADED = ["implementer", "code-reviewer", "doc-writer"];
const OWNED_DIRS = [".claude/agents", ".claude/skills/review-loop"];
const MODELS = ["sonnet", "opus", "haiku", "fable", "inherit"];
// 方針: 設計・判断・反証・監査と、その仕分けはopus。実装・コードレビュー・文書の追従はsonnet。
const EXPECTED_MODELS: [string, string][] = [
  ["implementer", "sonnet"],
  ["code-reviewer", "sonnet"],
  ["doc-writer", "sonnet"],
  ["design-reviewer", "opus"],
  ["requirements-reviewer", "opus"],
  ["devil-advocate", "opus"],
  ["security-auditor", "opus"],
  ["triage", "opus"],
];
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

function body(name: string): string {
  return readFileSync(join(AGENTS_DIR, `${name}.md`), "utf8");
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

  test.each(EXPECTED_MODELS)("runs %s on %s", (name, model) => {
    expect(frontmatter(name).model).toBe(model);
  });

  test.each(AGENTS)("lists at least one tool for %s", (name) => {
    expect(tools(name).length).toBeGreaterThan(0);
  });

  test.each(READ_ONLY_AGENTS)("keeps %s free of write tools", (name) => {
    expect(tools(name).filter((tool) => WRITE_TOOL.test(tool))).toEqual([]);
  });

  // Bashを持つ読み取り専用のagentは、指示でしか書き込みを止められない。
  test.each(READ_ONLY_AGENTS)("forbids commit and push in %s", (name) => {
    expect(body(name)).toContain("`git commit`、`git push`");
  });

  test.each(READ_ONLY_AGENTS)("forbids reading secret files in %s", (name) => {
    expect(body(name)).toContain(
      "`mise.local.toml`、`.wmill/`、`*.local.*`は読まない",
    );
  });

  test.each(AGENTS)("treats outside text as untrusted in %s", (name) => {
    expect(body(name)).toContain("信頼できない入力として読む");
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

  const REVIEW_ROLES = [
    "code-reviewer",
    "devil-advocate",
    "security-auditor",
    "requirements-reviewer",
    "design-reviewer",
  ];

  test.each(REVIEW_ROLES)("points %s at the review rules", (name) => {
    expect(body(name)).toContain(".claude/skills/review-loop/rules.md");
  });

  const FINDING_FIELDS = ["重さ:", "種類:", "原因: <原因の分類>", "範囲:"];
  const FINDING_CASES = REVIEW_ROLES.flatMap((name) =>
    FINDING_FIELDS.map((field): [string, string] => [name, field]),
  );

  test.each(FINDING_CASES)(
    "asks %s for the finding field %s",
    (name, field) => {
      expect(body(name)).toContain(field);
    },
  );

  test("makes security-auditor report the audited HEAD", () => {
    expect(body("security-auditor")).toContain("監査した HEAD: <sha>");
  });

  test("runs triage on the same model as devil-advocate", () => {
    expect(frontmatter("triage").model).toBe(
      frontmatter("devil-advocate").model,
    );
  });

  test("runs triage on the same model as security-auditor", () => {
    expect(frontmatter("triage").model).toBe(
      frontmatter("security-auditor").model,
    );
  });

  test("makes triage answer security questions as blockers", () => {
    expect(body("triage")).toContain("親が答える(blocker)");
  });

  test("lets triage send an upstream fix to the parent", () => {
    expect(body("triage")).toContain("取り入れる(上流を親が直す)");
  });

  test("lets triage record accepted topics as settled", () => {
    expect(body("triage")).toContain("受け入れ済み");
  });

  test("lets triage record answered questions as settled", () => {
    expect(body("triage")).toContain("回答済み");
  });

  test("makes triage settle an answered question with the verified basis", () => {
    expect(body("triage")).toContain("回答済み / <要旨> / <確かめた根拠>");
  });

  test("makes triage return a supplement for a returned question", () => {
    expect(body("triage")).toContain("追補");
  });

  test("keeps round-specific handling of questions out of security-auditor", () => {
    expect(body("security-auditor")).not.toContain("上限のラウンド");
  });

  test.each(["code-reviewer", "design-reviewer", "requirements-reviewer"])(
    "keeps %s from re-raising settled topics without new grounds",
    (name) => {
      expect(body(name)).toContain("新しい根拠が無ければ出し直さない");
    },
  );

  test("makes triage report the severity before and after raising it", () => {
    expect(body("triage")).toContain("重さ(前→後)");
  });

  test("makes triage decide by the numbered criteria", () => {
    expect(body("triage")).toContain("見送る(基準<番号>)");
  });

  test("makes triage report the kind before and after reclassifying", () => {
    expect(body("triage")).toContain("種類(前→後)");
  });
});

describe("repository-owned Claude config", () => {
  test("sets the default model to opusplan in .claude/settings.json", () => {
    const parsed: unknown = JSON.parse(
      readFileSync(join(ROOT, ".claude/settings.json"), "utf8"),
    );
    expect(isRecord(parsed) ? parsed.model : undefined).toBe("opusplan");
  });

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

  const RULES = join(ROOT, ".claude/skills/review-loop/rules.md");
  const RULES_HEADINGS = [
    "## 指摘の形",
    "## 重さ",
    "## 種類",
    "## 原因の分類",
    "## 出力の対応",
    "## 取り入れる基準",
    "## 範囲外の指摘",
    "## 差し戻し先",
  ];

  test.each(RULES_HEADINGS)("keeps %s in the review rules", (heading) => {
    expect(readFileSync(RULES, "utf8")).toContain(heading);
  });

  const SECURITY_CAUSES = ["注入", "秘密値の漏れ", "権限の拡大"];

  test.each(SECURITY_CAUSES)(
    "lists the cause %s in the review rules",
    (cause) => {
      expect(readFileSync(RULES, "utf8")).toContain(`| ${cause} |`);
    },
  );
});
