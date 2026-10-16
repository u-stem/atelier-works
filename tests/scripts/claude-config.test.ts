import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
    "## 致命的な反証",
    "## ループの終わりと残る指摘",
    "## 変更の種類の指摘",
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

describe("review-loop scaling rules", () => {
  const SKILL = join(ROOT, ".claude/skills/review-loop/SKILL.md");
  const skillText = (): string => readFileSync(SKILL, "utf8");

  /** `Bash`で実行してよいコマンドの一覧(「実行してよいのは」から「実行しない」まで)を返す。 */
  function allowedBash(name: string): string {
    const text = body(name);
    const start = text.indexOf("実行してよいのは");
    const end = text.indexOf("実行しない", start);
    if (start < 0 || end < 0) {
      throw new Error(`${name} has no allowed-command list`);
    }
    return text.slice(start, end);
  }

  /** 見出しの行そのものを探す。`###`の行は、`####`の見出しには当たらない。 */
  function hasHeading(text: string, heading: string): boolean {
    return text.split("\n").includes(heading);
  }

  /** 表の行を、セルの配列にして返す。 */
  function tableRow(text: string, first: string): string[] {
    const line = text
      .split("\n")
      .find((row) => row.startsWith(`| ${first} | `));
    if (line === undefined) throw new Error(`no table row for ${first}`);
    return line
      .split("|")
      .map((cell) => cell.trim())
      .filter((cell) => cell !== "");
  }

  const SKILL_HEADINGS = [
    "## 変更の種類",
    "### 数え方",
    "### 設計レビュー",
    "## 前提の検証",
    "## 範囲の固定",
    "#### 致命的な反証",
    "## テスト先行の確認",
    "## mainを取り込んだとき",
  ];

  test.each(SKILL_HEADINGS)("keeps %s in the review-loop skill", (heading) => {
    expect(hasHeading(skillText(), heading)).toBe(true);
  });

  test("does not match a heading by a longer heading", () => {
    expect(hasHeading(skillText(), "### 致命的な反証")).toBe(false);
  });

  test("measures the size against the merge base", () => {
    expect(skillText()).toContain("git diff --numstat origin/main...HEAD");
  });

  const TRIAGE_TRIGGERS = [
    "- 機能と削除・権限の、各ラウンドの後。",
    "- 設計レビューの、各ラウンドの後。",
    "- 種類を問わず、devil-advocateの致命的な反証があるとき。",
    "- 種類を問わず、種類がセキュリティの指摘があるとき。",
    "- 種類を問わず、種類がセキュリティの`[Q]`があるとき。",
    "- 種類を問わず、security-auditorの指摘があるとき。",
  ];

  test.each(TRIAGE_TRIGGERS)("starts triage when %s", (trigger) => {
    expect(skillText()).toContain(trigger);
  });

  test.each(["小", "機能", "削除・権限"])(
    "runs security-auditor for the kind %s",
    (kind) => {
      expect(tableRow(skillText(), kind)[4]).not.toBe("不要");
    },
  );

  test("leaves the document kind without security-auditor", () => {
    expect(tableRow(skillText(), "文書")[4]).toBe("不要");
  });

  /** 種類の定義のうち、「1. 文書。」から「2. 削除・権限。」の手前までを返す。 */
  function documentKind(): string {
    const text = skillText();
    const start = text.indexOf("1. 文書。");
    const end = text.indexOf("2. 削除・権限。");
    if (start < 0 || end < start) throw new Error("no document kind section");
    return text.slice(start, end);
  }

  const GUIDANCE_FILES = [
    "AGENTS.md",
    "CLAUDE.md",
    "AGENTS.wmill.md",
    "`docs/security.md`",
    "`docs/coding-guidelines.md`",
    "`docs/setup.md`",
    "`docs/operations.md`",
  ];

  test.each(GUIDANCE_FILES)(
    "lists %s as a file outside the document kind",
    (file) => {
      expect(documentKind()).toContain(file);
    },
  );

  test("keeps loosening wording out of the document kind", () => {
    expect(documentKind()).toContain("2の削除・権限に当たらない");
  });

  test("puts any change under .claude/ in the deletion and permission kind", () => {
    expect(skillText()).toContain(
      "`.claude/`の下(skills、agents、settings、hooks)は、文言だけの変更でも、常にここに入る。",
    );
  });

  test("excludes the lockfile at every depth from the line count", () => {
    const command = /^git diff --numstat .*$/m.exec(skillText())?.[0] ?? "";
    const pathspecs = command.match(/':\([^']*\)[^']*'/g) ?? [];
    const dir = mkdtempSync(join(tmpdir(), "numstat-"));
    const git = (...args: string[]): string => {
      const run = Bun.spawnSync(
        [
          "git",
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@example.com",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { cwd: dir, env: { PATH: process.env.PATH ?? "", HOME: dir } },
      );
      return run.stdout.toString();
    };
    try {
      git("init", "-q", "-b", "main");
      writeFileSync(join(dir, "bun.lock"), "a\n");
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "sub/bun.lock"), "a\n");
      writeFileSync(join(dir, "src.ts"), "a\n");
      git("add", ".");
      git("commit", "-q", "-m", "base");
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      writeFileSync(join(dir, "bun.lock"), "b\n");
      writeFileSync(join(dir, "sub/bun.lock"), "b\n");
      writeFileSync(join(dir, "src.ts"), "b\n");
      git("commit", "-q", "-am", "change");
      const out = git(
        "diff",
        "--numstat",
        "origin/main...HEAD",
        "--",
        ".",
        ...pathspecs.map((spec) => spec.slice(1, -1)),
      );
      expect(out.trim().split("\n")).toEqual(["1\t1\tsrc.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const FATAL_CRITERIA =
    "基準1(根拠が無い)と、基準3(新しい根拠の無い蒸し返しに限る)だけ";

  test.each([
    ".claude/skills/review-loop/rules.md",
    ".claude/skills/review-loop/SKILL.md",
    ".claude/agents/triage.md",
  ])("names the same criteria for a fatal rebuttal in %s", (path) => {
    expect(readFileSync(join(ROOT, path), "utf8")).toContain(FATAL_CRITERIA);
  });

  test("lets test files under console/ pass the file-name check", () => {
    expect(skillText()).toContain("^(tests|console)/[A-Za-z0-9_./-]+");
  });

  test("refuses a file name with a parent-directory segment", () => {
    expect(skillText()).toContain("/\\.\\.(\\/|$)/");
  });

  test("keeps mise run check out of devil-advocate's allowed commands", () => {
    expect(allowedBash("devil-advocate")).not.toContain("mise run check");
  });

  test("keeps mise run check out of design-reviewer's allowed commands", () => {
    expect(allowedBash("design-reviewer")).not.toContain("mise run check");
  });

  test("makes devil-advocate name the kind of ground", () => {
    expect(body("devil-advocate")).toContain("根拠の種類:");
  });

  test("leaves the definition of a fatal rebuttal to the review rules", () => {
    expect(body("devil-advocate")).toContain("`rules.md`の「致命的な反証」");
  });

  test("makes implementer report the test-first record", () => {
    expect(body("implementer")).toContain("## テスト先行の記録");
  });

  test("makes implementer report the verified premises", () => {
    expect(body("implementer")).toContain("## 前提の検証");
  });

  test("separates the first review range from the fix round range", () => {
    expect(body("code-reviewer")).toContain(
      "- 最初のレビューでは、`git log --reverse --stat origin/main..HEAD`(二点)を見る。",
    );
  });

  test("names the fix round range as a separate case", () => {
    expect(body("code-reviewer")).toContain(
      "- 修正のラウンドでは、`git log --reverse --stat <前のラウンドのHEAD>..HEAD`を見る。",
    );
  });

  test("keeps no sentence about a raised limit that cannot happen", () => {
    expect(skillText()).not.toContain("新しい上限を超えている");
  });

  test("has the parent pass the previous round's HEAD", () => {
    expect(skillText()).toContain("前のラウンドのHEAD");
  });

  test("makes code-reviewer check the fix commits since the previous round", () => {
    expect(body("code-reviewer")).toContain(
      "`git log --reverse --stat <前のラウンドのHEAD>..HEAD`",
    );
  });

  test("makes implementer put each fix's test before the fix", () => {
    expect(body("implementer")).toContain(
      "修正のラウンドでも、テストを足すコミットを、修正のコミットより前に作る。",
    );
  });

  test("makes code-reviewer check the commit order of the tests", () => {
    expect(body("code-reviewer")).toContain(
      "git log --reverse --stat origin/main..HEAD",
    );
  });
});
