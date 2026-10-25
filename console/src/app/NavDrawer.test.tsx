import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NavDrawer } from "./NavDrawer.tsx";

describe("NavDrawer", () => {
  test("marks its dialog so the route focus can wait for it to close", () => {
    expect(
      renderToStaticMarkup(
        <NavDrawer open={false} label="メニュー" onClose={() => undefined}>
          <p>中身</p>
        </NavDrawer>,
      ),
    ).toContain("data-nav-drawer");
  });
});
