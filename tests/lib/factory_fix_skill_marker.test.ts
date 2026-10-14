import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CI_FENCE_LABEL_CHANGED_FILES,
  CI_FENCE_LABEL_FAILURE_PREFIX,
  CI_ROUND_PROMPT_CUE,
} from "../../f/factory/lib/ci_fix_prompt.ts";
import {
  CI_FIX_SKILL_MARKER,
  hasCiFixSkillMarker,
} from "../../f/factory/lib/ci_fix_round.ts";

const REPO_ROOT = join(import.meta.dir, "../..");
const skillText = readFileSync(
  join(REPO_ROOT, ".claude/skills/factory-fix/SKILL.md"),
  "utf8",
);
const CI_SECTION_HEADING = "## CIの失敗を直す回";

describe("factory-fix skill marker", () => {
  test("holds the marker that the CI round requires", () => {
    expect(hasCiFixSkillMarker(skillText)).toBe(true);
  });

  test("holds the marker exactly once", () => {
    const count = skillText.split(CI_FIX_SKILL_MARKER).length - 1;

    expect(count).toBe(1);
  });

  test("places the marker directly after the CI section heading", () => {
    const expected = `${CI_SECTION_HEADING}\n\n<!-- ${CI_FIX_SKILL_MARKER} -->\n`;

    expect(skillText).toContain(expected);
  });

  test("names the cue that the CI round prompt carries", () => {
    expect(skillText).toContain(`\`${CI_ROUND_PROMPT_CUE}\``);
  });

  test("names the fence label of the changed files", () => {
    expect(skillText).toContain(`\`${CI_FENCE_LABEL_CHANGED_FILES}\``);
  });

  test("names the fence label prefix of the failure logs", () => {
    expect(skillText).toContain(`\`${CI_FENCE_LABEL_FAILURE_PREFIX} <番号>\``);
  });
});
