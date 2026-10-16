import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFLICT_FENCE_LABEL_PATHS,
  CONFLICT_FIX_SCHEMA,
  CONFLICT_ROUND_PROMPT_CUE,
} from "../../f/factory/lib/conflict_fix_prompt.ts";
import {
  CONFLICT_FIX_SKILL_MARKER,
  hasConflictFixSkillMarker,
} from "../../f/factory/lib/conflict_fix_round.ts";

const REPO_ROOT = join(import.meta.dir, "../..");
const skillText = readFileSync(
  join(REPO_ROOT, ".claude/skills/factory-fix/SKILL.md"),
  "utf8",
);
const CONFLICT_SECTION_HEADING = "## マージの競合を解く回";

/** 競合回の節の本文。次の`## `の見出しまで、無ければ末尾まで。 */
function conflictSection(): string {
  const start = skillText.indexOf(CONFLICT_SECTION_HEADING);
  const next = skillText.indexOf("\n## ", start + 1);
  return next === -1 ? skillText.slice(start) : skillText.slice(start, next);
}

describe("factory-fix skill marker of the conflict round", () => {
  test("holds the marker that the conflict round requires", () => {
    expect(hasConflictFixSkillMarker(skillText)).toBe(true);
  });

  test("holds the marker exactly once", () => {
    const count = skillText.split(CONFLICT_FIX_SKILL_MARKER).length - 1;

    expect(count).toBe(1);
  });

  test("places the marker directly after the conflict section heading", () => {
    const expected = `${CONFLICT_SECTION_HEADING}\n\n<!-- ${CONFLICT_FIX_SKILL_MARKER} -->\n`;

    expect(skillText).toContain(expected);
  });

  test("names the cue that the conflict round prompt carries", () => {
    expect(conflictSection()).toContain(`\`${CONFLICT_ROUND_PROMPT_CUE}\``);
  });

  test("names the fence label of the conflicted files", () => {
    expect(conflictSection()).toContain(`\`${CONFLICT_FENCE_LABEL_PATHS}\``);
  });

  test("says that the cue counts only outside the fence", () => {
    expect(conflictSection()).toContain(
      "囲みの外にある、呼び出し側の固定の文が競合回だと示したときだけである",
    );
  });

  test("lists every property of the output schema", () => {
    const section = conflictSection();
    const missing = Object.keys(CONFLICT_FIX_SCHEMA.properties).filter(
      (key) => !section.includes(`\`${key}\``),
    );

    expect(missing).toEqual([]);
  });
});
