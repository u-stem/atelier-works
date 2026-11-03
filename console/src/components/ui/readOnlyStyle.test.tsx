import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Input } from "./input.tsx";
import { Textarea } from "./textarea.tsx";

/** 描いた要素のclassの並び。 */
function classesOf(element: ReactElement): string[] {
  const html = renderToStaticMarkup(element);
  const found = /^<[a-z]+ [^>]*class="([^"]*)"/.exec(html);
  if (found === null) throw new Error(`no class in ${html}`);
  return (found[1] ?? "").split(" ");
}

const PARTS = {
  Input: () => classesOf(<Input />),
  Textarea: () => classesOf(<Textarea />),
};

// disabledの欄も読み取り専用に当たるので、enabledに絞る。絞らないと、disabledの欄の見た目に重なる。
const READ_ONLY_TOKENS = [
  "read-only:enabled:bg-muted",
  "read-only:enabled:cursor-not-allowed",
  "read-only:enabled:border-dashed",
];

for (const [name, draw] of Object.entries(PARTS)) {
  describe(`${name} read-only style`, () => {
    test.each(READ_ONLY_TOKENS)("has %s", (token) => {
      expect(draw()).toContain(token);
    });

    test("has no read-only style that is not limited to enabled fields", () => {
      expect(
        draw().filter(
          (token) =>
            token.startsWith("read-only:") &&
            !token.startsWith("read-only:enabled:"),
        ),
      ).toEqual([]);
    });
  });
}
