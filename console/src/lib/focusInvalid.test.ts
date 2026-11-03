import { describe, expect, test } from "bun:test";
import {
  clearedStatus,
  focusFirstInvalid,
  type InvalidCounter,
  type InvalidSource,
  invalidAnnouncement,
} from "./focusInvalid.ts";

/** 見つかる要素と、フォーカスされた回数を持つ入れ物。 */
function sourceWith(found: boolean): {
  readonly source: InvalidSource;
  readonly focused: () => number;
} {
  let count = 0;
  const control = {
    focus: () => {
      count += 1;
    },
  };
  return {
    source: { querySelector: () => (found ? control : null) },
    focused: () => count,
  };
}

describe("focusFirstInvalid", () => {
  test("reports that it moved the focus when a control is invalid", () => {
    const { source } = sourceWith(true);

    expect(focusFirstInvalid(source)).toBe(true);
  });

  test("focuses the invalid control once", () => {
    const { source, focused } = sourceWith(true);

    focusFirstInvalid(source);

    expect(focused()).toBe(1);
  });

  test("reports that it did nothing when no control is invalid", () => {
    const { source } = sourceWith(false);

    expect(focusFirstInvalid(source)).toBe(false);
  });

  test("focuses nothing when no control is invalid", () => {
    const { source, focused } = sourceWith(false);

    focusFirstInvalid(source);

    expect(focused()).toBe(0);
  });

  test("looks for the controls marked invalid", () => {
    const selectors: string[] = [];
    const source: InvalidSource = {
      querySelector: (selector) => {
        selectors.push(selector);
        return null;
      },
    };

    focusFirstInvalid(source);

    expect(selectors).toEqual(['[aria-invalid="true"]']);
  });
});

/** 誤りのある入力欄の並びを持つフォームの代わり。先頭が最初の誤りになる。 */
function formWith(count: number): {
  readonly source: InvalidCounter;
  readonly controls: readonly { readonly focus: () => void }[];
} {
  const controls = Array.from({ length: count }, () => ({ focus: () => {} }));
  return {
    controls,
    source: {
      querySelector: () => controls[0] ?? null,
      querySelectorAll: () => controls,
    },
  };
}

describe("invalidAnnouncement", () => {
  test("says how many controls are invalid when the focus is already on the first", () => {
    const { source, controls } = formWith(3);

    expect(invalidAnnouncement(source, controls[0])).toBe(
      "入力に誤りがあります(3件)",
    );
  });

  test("says nothing when the focus is on another control", () => {
    const { source } = formWith(2);

    expect(invalidAnnouncement(source, {})).toBe("");
  });

  test("says nothing when the focus is on the second invalid control", () => {
    const { source, controls } = formWith(2);

    expect(invalidAnnouncement(source, controls[1])).toBe("");
  });

  test("says nothing when no control is invalid", () => {
    const { source } = formWith(0);

    expect(invalidAnnouncement(source, null)).toBe("");
  });
});

describe("clearedStatus", () => {
  test("empties the text of a status that announced the problems", () => {
    expect(
      clearedStatus({ text: "入力に誤りがあります(2件)", serial: 3 }).text,
    ).toBe("");
  });

  test("keeps the serial, so that the next announcement is read again", () => {
    expect(
      clearedStatus({ text: "入力に誤りがあります(2件)", serial: 3 }).serial,
    ).toBe(3);
  });

  test("returns the same value for an empty status, so that nothing is drawn again", () => {
    const empty = { text: "", serial: 2 };

    expect(clearedStatus(empty)).toBe(empty);
  });
});
