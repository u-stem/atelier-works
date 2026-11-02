import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Card } from "./card.tsx";

/** 描いた最初の要素のclassの並び。 */
function classesOf(element: ReactElement): string[] {
  const html = renderToStaticMarkup(element);
  const found = /^<[a-z]+ [^>]*class="([^"]*)"/.exec(html);
  if (found === null) throw new Error(`no class in ${html}`);
  return (found[1] ?? "").split(" ");
}

describe("Card", () => {
  test("renders a div by default", () => {
    expect(renderToStaticMarkup(<Card>x</Card>)).toMatch(/^<div /);
  });

  test("renders the element named by tag", () => {
    expect(renderToStaticMarkup(<Card tag="ul">x</Card>)).toMatch(/^<ul /);
  });

  test("marks itself with data-slot", () => {
    expect(renderToStaticMarkup(<Card>x</Card>)).toContain('data-slot="card"');
  });

  test("draws the default variant as a bordered card surface", () => {
    expect(classesOf(<Card>x</Card>)).toEqual(
      expect.arrayContaining([
        "rounded-xl",
        "border",
        "border-border",
        "bg-card",
      ]),
    );
  });

  test("leaves the default variant without dividers", () => {
    expect(classesOf(<Card>x</Card>)).not.toContain("divide-y");
  });

  test("divides the rows of the list variant", () => {
    expect(classesOf(<Card variant="list">x</Card>)).toEqual(
      expect.arrayContaining(["divide-y", "divide-border", "bg-card"]),
    );
  });

  test("draws the empty variant with a dashed border", () => {
    expect(classesOf(<Card variant="empty">x</Card>)).toContain(
      "border-dashed",
    );
  });

  test("leaves the empty variant without a filled surface", () => {
    expect(classesOf(<Card variant="empty">x</Card>)).not.toContain("bg-card");
  });

  test("mutes the text of the empty variant", () => {
    expect(classesOf(<Card variant="empty">x</Card>)).toEqual(
      expect.arrayContaining(["text-small", "text-muted-foreground"]),
    );
  });

  test("pads the empty variant by default", () => {
    expect(classesOf(<Card variant="empty">x</Card>)).toEqual(
      expect.arrayContaining(["px-5", "py-3"]),
    );
  });

  test("pads the empty variant widely when asked", () => {
    expect(
      classesOf(
        <Card variant="empty" padding="spacious">
          x
        </Card>,
      ),
    ).toContain("py-8");
  });

  test("pads the spacious step with px-5", () => {
    expect(classesOf(<Card padding="spacious">x</Card>)).toContain("px-5");
  });

  test("leaves the default variant unpadded", () => {
    expect(classesOf(<Card>x</Card>).some((c) => /^p[xy]?-/.test(c))).toBe(
      false,
    );
  });

  test("pads the default step with px-5 and py-4", () => {
    expect(classesOf(<Card padding="default">x</Card>)).toEqual(
      expect.arrayContaining(["px-5", "py-4"]),
    );
  });

  test("pads the compact step with px-5 and py-3", () => {
    expect(classesOf(<Card padding="compact">x</Card>)).toEqual(
      expect.arrayContaining(["px-5", "py-3"]),
    );
  });

  test("keeps the horizontal padding of every step with a horizontal inset at px-5", () => {
    const steps = ["compact", "default", "spacious"] as const;
    expect(
      steps.map((padding) =>
        classesOf(<Card padding={padding}>x</Card>).filter((c) =>
          c.startsWith("px-"),
        ),
      ),
    ).toEqual([["px-5"], ["px-5"], ["px-5"]]);
  });

  test("pads the frame step with p-2", () => {
    expect(classesOf(<Card padding="frame">x</Card>)).toContain("p-2");
  });

  test("lets className override the border color", () => {
    expect(
      classesOf(<Card className="border-failure/30">x</Card>),
    ).not.toContain("border-border");
  });

  test("keeps the className the caller adds", () => {
    expect(classesOf(<Card className="overflow-hidden">x</Card>)).toContain(
      "overflow-hidden",
    );
  });

  test("passes attributes through", () => {
    expect(renderToStaticMarkup(<Card aria-label="a">x</Card>)).toContain(
      'aria-label="a"',
    );
  });
});
