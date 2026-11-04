import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const OWNED_DIRS = [".claude/skills/hold"];

// 外部の設定リポジトリの名前は、このテスト自身が検出されないよう、部品から組み立てる。
const FORBIDDEN = new RegExp(
  ["/Users/", "/home/[a-z]", "~/ws/", ["claude", "system"].join("-")].join("|"),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listFiles(dir: string): string[] {
  const absolute = join(ROOT, dir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { recursive: true })
    .map((entry) => join(dir, String(entry)))
    .filter((path) => statSync(join(ROOT, path)).isFile());
}

type ConfigFile = { path: string; meta: Record<string, unknown> };

// `.claude/skills/*/SKILL.md`のfrontmatterを集める。
// `SKILL.md`の無いフォルダは飛ばす。
function skillFrontmatters(): ConfigFile[] {
  const skillFiles = readdirSync(join(ROOT, ".claude/skills"))
    .map((dir) => join(".claude/skills", dir, "SKILL.md"))
    .filter((path) => existsSync(join(ROOT, path)));
  return skillFiles.map((path) => {
    const text = readFileSync(join(ROOT, path), "utf8");
    const block = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
    const parsed: unknown = Bun.YAML.parse(block);
    return { path, meta: isRecord(parsed) ? parsed : {} };
  });
}

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

  // 同梱のyomiyasuは、frontmatterとsettingsにフックを登録しない。
  // `allowed-tools`はスクリプトの実行を確認なしで許し、
  // `hooks`はツールの実行と返答の終了を止める判定を返すためである。
  test("reads a name from every skill frontmatter", () => {
    const files = skillFrontmatters();

    const unnamed = files.filter(
      ({ meta }) => typeof meta.name !== "string" || meta.name === "",
    );
    expect(unnamed.map(({ path }) => path)).toEqual([]);
    expect(files.map(({ path }) => path)).toContain(
      ".claude/skills/yomiyasu/SKILL.md",
    );
  });

  test("declares no allowed-tools in any skill frontmatter", () => {
    const offenders = skillFrontmatters().filter(({ meta }) =>
      Object.hasOwn(meta, "allowed-tools"),
    );

    expect(offenders.map(({ path }) => path)).toEqual([]);
  });

  test("declares no hooks in any skill frontmatter", () => {
    const offenders = skillFrontmatters().filter(({ meta }) =>
      Object.hasOwn(meta, "hooks"),
    );

    expect(offenders.map(({ path }) => path)).toEqual([]);
  });

  test("does not mention yomiyasu in settings", () => {
    const settings = readFileSync(join(ROOT, ".claude/settings.json"), "utf8");

    expect(settings).not.toContain("yomiyasu");
  });

  test("does not ship the review-loop skill", () => {
    expect(existsSync(join(ROOT, ".claude/skills/review-loop"))).toBe(false);
  });
});

describe(".claude/agents", () => {
  test("has no repository-owned agent definitions", () => {
    expect(existsSync(join(ROOT, ".claude/agents"))).toBe(false);
  });
});
