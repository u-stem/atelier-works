import { describe, expect, test } from "bun:test";
import {
  JUMP_OPEN_ATTRIBUTE,
  JUMP_OPEN_SELECTOR,
  openJumpDisclosures,
} from "./sectionJump.ts";

function scopeOf(disclosures: { open: boolean }[]) {
  const asked: string[] = [];
  return {
    asked,
    scope: {
      querySelectorAll(selector: string) {
        asked.push(selector);
        return disclosures;
      },
    },
  };
}

describe("JUMP_OPEN_SELECTOR", () => {
  test("picks only the details that carry the jump attribute", () => {
    expect(JUMP_OPEN_SELECTOR).toBe(`details[${JUMP_OPEN_ATTRIBUTE}]`);
  });
});

describe("openJumpDisclosures", () => {
  test("opens a closed disclosure", () => {
    const closed = { open: false };
    openJumpDisclosures(scopeOf([closed]).scope);
    expect(closed.open).toBe(true);
  });

  test("keeps an open disclosure open", () => {
    const opened = { open: true };
    openJumpDisclosures(scopeOf([opened]).scope);
    expect(opened.open).toBe(true);
  });

  test("opens every disclosure of the section", () => {
    const list = [{ open: false }, { open: false }];
    openJumpDisclosures(scopeOf(list).scope);
    expect(list.map((item) => item.open)).toEqual([true, true]);
  });

  test("counts the disclosures it opened, not the ones already open", () => {
    expect(
      openJumpDisclosures(
        scopeOf([{ open: false }, { open: true }, { open: false }]).scope,
      ),
    ).toBe(2);
  });

  test("opens nothing for a section without a disclosure", () => {
    expect(openJumpDisclosures(scopeOf([]).scope)).toBe(0);
  });

  test("searches with the jump selector", () => {
    const { asked, scope } = scopeOf([]);
    openJumpDisclosures(scope);
    expect(asked).toEqual([JUMP_OPEN_SELECTOR]);
  });
});
