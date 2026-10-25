import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MAIN_ID } from "../lib/routeFocus.ts";
import { SkipLink, skipToMain } from "./SkipLink.tsx";

describe("SkipLink", () => {
  test("points at the main area", () => {
    expect(renderToStaticMarkup(<SkipLink />)).toContain(`href="#${MAIN_ID}"`);
  });

  test("says what it skips to", () => {
    expect(renderToStaticMarkup(<SkipLink />)).toContain("本文へスキップ");
  });

  test("is hidden from the eye until it gets the focus", () => {
    expect(renderToStaticMarkup(<SkipLink />)).toContain("sr-only");
  });

  test("appears when it gets the focus", () => {
    expect(renderToStaticMarkup(<SkipLink />)).toContain("focus:not-sr-only");
  });
});

describe("skipToMain", () => {
  test("cancels the default jump so the address gets no hash", () => {
    let prevented = false;
    skipToMain(
      {
        preventDefault: () => {
          prevented = true;
        },
      },
      { focus: () => undefined },
    );
    expect(prevented).toBe(true);
  });

  test("moves the focus to main", () => {
    const calls: string[] = [];
    skipToMain(
      { preventDefault: () => undefined },
      {
        focus: (options) => {
          calls.push(JSON.stringify(options ?? null));
        },
      },
    );
    expect(calls).toEqual(['{"preventScroll":true}']);
  });

  test("does nothing without a main element", () => {
    expect(() =>
      skipToMain({ preventDefault: () => undefined }, null),
    ).not.toThrow();
  });
});
