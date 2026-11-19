import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  COMMON_SKILL_NAMES,
  SKILLS_BY_STAGE,
  skillsFor,
} from "../../f/factory/lib/skill_registry.ts";

const SKILLS_DIR = fileURLToPath(
  new URL("../../.claude/skills/", import.meta.url),
);

/**
 * どの工程にも登録しない`factory-*`のスキル。
 * Factoryの実行に注入せず、人とClaudeの開発セッションが読む手引きだけである。
 */
const UNINJECTED_FACTORY_SKILLS: readonly string[] = [
  "factory-dev",
  "factory-docs",
];

const registeredNames: readonly string[] = [
  ...COMMON_SKILL_NAMES,
  ...Object.values(SKILLS_BY_STAGE).flat(),
];

function factorySkillDirectories(): string[] {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("factory-"))
    .map((entry) => entry.name);
}

describe("skillsFor", () => {
  // 各工程が登録簿の導入前に直書きしていた一覧。注入するスキルを変えないことの基準である。
  test.each([
    ["generate_requirements", ["factory-requirements", "drawio-diagram"]],
    ["generate_design", ["factory-design", "drawio-diagram"]],
    ["pr_review", ["factory-review"]],
    ["pr_fix", ["factory-fix"]],
    ["pr_fix_verify_retry", ["factory-fix"]],
    ["implement", ["factory-implementation"]],
    ["implement_fix", ["factory-implementation"]],
    ["investigate", ["factory-investigate"]],
    ["audit", ["factory-audit"]],
    ["dependabot_assess", ["factory-dependabot"]],
  ] as const)(
    "returns the list the %s stage passed before the registry",
    (stage, expected) => {
      expect(skillsFor(stage)).toEqual(expected);
    },
  );

  test("returns the list registered in SKILLS_BY_STAGE", () => {
    expect(skillsFor("pr_review")).toBe(SKILLS_BY_STAGE.pr_review);
  });
});

describe("COMMON_SKILL_NAMES", () => {
  test("lists the writing rules that every run receives", () => {
    expect(COMMON_SKILL_NAMES).toEqual(["factory-writing"]);
  });
});

describe("registered skills", () => {
  test.each([...new Set(registeredNames)])("%s has a SKILL.md", (name) => {
    expect(existsSync(`${SKILLS_DIR}${name}/SKILL.md`)).toBe(true);
  });

  test("every factory skill is registered or listed as uninjected", () => {
    const missing = factorySkillDirectories().filter(
      (name) =>
        !registeredNames.includes(name) &&
        !UNINJECTED_FACTORY_SKILLS.includes(name),
    );
    expect(missing).toEqual([]);
  });

  test("the uninjected list names only skills that exist and are not registered", () => {
    const stale = UNINJECTED_FACTORY_SKILLS.filter(
      (name) =>
        !factorySkillDirectories().includes(name) ||
        registeredNames.includes(name),
    );
    expect(stale).toEqual([]);
  });

  test.each(Object.entries(SKILLS_BY_STAGE))(
    "the %s stage has no duplicate names",
    (_stage, names) => {
      expect(new Set(names).size).toBe(names.length);
    },
  );

  test.each(Object.entries(SKILLS_BY_STAGE))(
    "the %s stage does not repeat a common skill",
    (_stage, names) => {
      expect(names.filter((name) => COMMON_SKILL_NAMES.includes(name))).toEqual(
        [],
      );
    },
  );
});
