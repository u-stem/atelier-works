import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Dialog } from "./dialog.tsx";

const NOOP = (): void => undefined;

function markup(props: { placement?: "center" | "top" } = {}): string {
  return renderToStaticMarkup(
    <Dialog
      open={false}
      onClose={NOOP}
      aria-labelledby="heading"
      aria-describedby="note"
      {...props}
    >
      <h2 id="heading">題名</h2>
    </Dialog>,
  );
}

function classesOf(html: string): string[] {
  const found = /^<dialog [^>]*class="([^"]*)"/.exec(html);
  if (found === null) throw new Error(`no class in ${html}`);
  return (found[1] ?? "").split(" ");
}

describe("Dialog", () => {
  test("renders a native dialog element", () => {
    expect(markup()).toMatch(/^<dialog /);
  });

  test("renders its children", () => {
    expect(markup()).toContain('<h2 id="heading">題名</h2>');
  });

  test("passes aria-labelledby through", () => {
    expect(markup()).toContain('aria-labelledby="heading"');
  });

  test("passes aria-describedby through", () => {
    expect(markup()).toContain('aria-describedby="note"');
  });

  test("stays closed while open is false", () => {
    expect(markup()).not.toMatch(/^<dialog [^>]*\bopen\b/);
  });

  test("draws the popover surface with the raised shadow", () => {
    expect(classesOf(markup())).toEqual(
      expect.arrayContaining([
        "rounded-xl",
        "border-border",
        "bg-popover",
        "shadow-raised",
      ]),
    );
  });

  test("dims the backdrop", () => {
    expect(classesOf(markup())).toContain("backdrop:bg-black/50");
  });

  test("clears the padding of the native dialog", () => {
    expect(classesOf(markup())).toContain("p-0");
  });

  test("centers the dialog by default", () => {
    expect(classesOf(markup())).toContain("m-auto");
  });

  test("pins the top placement near the top edge", () => {
    expect(classesOf(markup({ placement: "top" }))).toContain("mt-[12vh]");
  });

  test("does not center the top placement", () => {
    expect(classesOf(markup({ placement: "top" }))).not.toContain("m-auto");
  });

  test("keeps the className the caller adds", () => {
    const html = renderToStaticMarkup(
      <Dialog open={false} onClose={NOOP} className="max-h-96">
        x
      </Dialog>,
    );
    expect(classesOf(html)).toContain("max-h-96");
  });
});
