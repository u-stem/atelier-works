import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Heading } from "../../lib/markdownHeadings.ts";
import { RequirementsTocList } from "./RequirementsToc.tsx";

const HEADINGS: readonly Heading[] = [
  { level: 2, text: "Background", id: "h-background", line: 3 },
  { level: 2, text: "Scope", id: "h-scope", line: 9 },
];

function render(activeId: string | null): string {
  return renderToStaticMarkup(
    <RequirementsTocList headings={HEADINGS} activeId={activeId} />,
  );
}

describe("RequirementsTocList", () => {
  test("marks the active section as the current location", () => {
    expect(render("h-scope")).toContain(
      'href="#h-scope" aria-current="location"',
    );
  });

  test("leaves the other sections unmarked", () => {
    expect(render("h-scope")).not.toContain(
      'href="#h-background" aria-current',
    );
  });

  test("marks nothing before the first heading", () => {
    expect(render(null)).not.toContain("aria-current");
  });
});
