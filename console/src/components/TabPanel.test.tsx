import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TabPanel } from "./TabPanel.tsx";

const SHOWN = { id: "p-one", labelledBy: "t-one", hidden: false };
const HIDDEN = { id: "p-two", labelledBy: "t-two", hidden: true };

function render(attrs: typeof SHOWN, mounted?: boolean): string {
  return renderToStaticMarkup(
    <TabPanel attrs={attrs} {...(mounted === undefined ? {} : { mounted })}>
      <p>中身</p>
    </TabPanel>,
  );
}

describe("TabPanel", () => {
  test("is a tabpanel", () => {
    expect(render(SHOWN)).toContain('role="tabpanel"');
  });

  test("carries the id that its tab points at", () => {
    expect(render(SHOWN)).toContain('id="p-one"');
  });

  test("is labelled by its tab", () => {
    expect(render(SHOWN)).toContain('aria-labelledby="t-one"');
  });

  test("is not hidden when selected", () => {
    expect(render(SHOWN)).not.toContain("hidden");
  });

  test("is hidden when not selected", () => {
    expect(render(HIDDEN)).toContain("hidden");
  });

  test("keeps the children while hidden", () => {
    expect(render(HIDDEN)).toContain("中身");
  });

  test("draws the children by default", () => {
    expect(render(SHOWN)).toContain("中身");
  });

  test("leaves the children out until it is mounted", () => {
    expect(render(HIDDEN, false)).not.toContain("中身");
  });

  test("keeps the frame while the children are left out", () => {
    expect(render(HIDDEN, false)).toContain('id="p-two"');
  });
});
