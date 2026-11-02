import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EmptyNote } from "./EmptyNote.tsx";

/** 描いた最初の要素のclassの並び。 */
function classesOf(html: string): string[] {
  const found = /^<[a-z]+ [^>]*class="([^"]*)"/.exec(html);
  if (found === null) throw new Error(`no class in ${html}`);
  return (found[1] ?? "").split(" ");
}

describe("EmptyNote", () => {
  test("renders a paragraph", () => {
    expect(renderToStaticMarkup(<EmptyNote>なし</EmptyNote>)).toMatch(/^<p /);
  });

  test("renders its children", () => {
    expect(
      renderToStaticMarkup(
        <EmptyNote>
          <b>なし</b>
        </EmptyNote>,
      ),
    ).toContain("<b>なし</b>");
  });

  test("draws a solid card surface", () => {
    expect(
      classesOf(renderToStaticMarkup(<EmptyNote>なし</EmptyNote>)),
    ).toEqual(
      expect.arrayContaining([
        "rounded-xl",
        "border",
        "border-border",
        "bg-card",
      ]),
    );
  });

  test("does not draw a dashed border", () => {
    expect(
      classesOf(renderToStaticMarkup(<EmptyNote>なし</EmptyNote>)),
    ).not.toContain("border-dashed");
  });

  test("pads with the default step", () => {
    expect(
      classesOf(renderToStaticMarkup(<EmptyNote>なし</EmptyNote>)),
    ).toEqual(expect.arrayContaining(["px-5", "py-4"]));
  });

  test("mutes the text at the small size", () => {
    expect(
      classesOf(renderToStaticMarkup(<EmptyNote>なし</EmptyNote>)),
    ).toEqual(expect.arrayContaining(["text-small", "text-muted-foreground"]));
  });

  test("keeps the className the caller adds", () => {
    expect(
      classesOf(
        renderToStaticMarkup(<EmptyNote className="max-w-3xl">なし</EmptyNote>),
      ),
    ).toContain("max-w-3xl");
  });
});
