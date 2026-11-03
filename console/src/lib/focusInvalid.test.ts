import { describe, expect, test } from "bun:test";
import { focusFirstInvalid, type InvalidSource } from "./focusInvalid.ts";

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
