import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NavDrawer } from "./NavDrawer.tsx";

function render(open: boolean): string {
  return renderToStaticMarkup(
    <NavDrawer open={open} label="メインメニュー" onClose={() => undefined}>
      <p>drawer body</p>
    </NavDrawer>,
  );
}

describe("NavDrawer", () => {
  test("renders its children", () => {
    expect(render(true)).toContain("drawer body");
  });

  test("names the dialog for assistive technology", () => {
    expect(render(true)).toContain('aria-label="メインメニュー"');
  });

  test("renders a dialog element", () => {
    expect(render(false)).toContain("<dialog");
  });

  test("does not mark the dialog open on the server", () => {
    expect(render(true)).not.toContain('open=""');
  });
});
