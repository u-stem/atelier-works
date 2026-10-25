import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MAIN_ID } from "../lib/routeFocus.ts";
import { AppMain } from "./AppShell.tsx";

function render(name: string | null): string {
  return renderToStaticMarkup(
    <AppMain name={name}>
      <p>本文</p>
    </AppMain>,
  );
}

describe("AppMain", () => {
  test("has the id the skip link points at", () => {
    expect(render("システム")).toContain(`id="${MAIN_ID}"`);
  });

  test("can take the focus from a script but not from the Tab key", () => {
    expect(render("システム")).toContain('tabindex="-1"');
  });

  test("names the landmark with the screen name", () => {
    expect(render("システム")).toContain('aria-label="システム"');
  });

  test("leaves the landmark unnamed without a screen name", () => {
    expect(render(null)).not.toContain("aria-label");
  });

  test("draws no focus ring around the whole area", () => {
    expect(render("システム")).toContain("outline-none");
  });

  test("renders the screen inside", () => {
    expect(render("システム")).toContain("<p>本文</p>");
  });
});
