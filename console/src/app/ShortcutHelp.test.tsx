import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Platform } from "../lib/shortcutKeys.ts";
import { ShortcutHelp } from "./ShortcutHelp.tsx";
import { SCREENS } from "./screens.ts";

function render(enabled = true, platform: Platform = "other"): string {
  return renderToStaticMarkup(
    <ShortcutHelp
      open={false}
      onClose={() => undefined}
      enabled={enabled}
      onEnabledChange={() => undefined}
      platform={platform}
    />,
  );
}

function checkboxTag(html: string): string {
  return /<input [^>]*type="checkbox"[^>]*>/.exec(html)?.[0] ?? "";
}

describe("ShortcutHelp", () => {
  test("is a dialog named by its heading", () => {
    const labelledBy = /<dialog [^>]*aria-labelledby="([^"]*)"/.exec(
      render(),
    )?.[1];
    expect(render()).toContain(`id="${labelledBy}"`);
  });

  test("lists the move to every screen in the table", () => {
    const html = render();
    expect(
      SCREENS.filter((screen) => !html.includes(`${screen.label}へ移る`)),
    ).toEqual([]);
  });

  test("lists the key of every screen in the table", () => {
    const html = render();
    expect(
      SCREENS.filter((screen) => !html.includes(`>${screen.shortcut}</kbd>`)),
    ).toEqual([]);
  });

  test("lists the palette key with Ctrl elsewhere", () => {
    expect(render(true, "other")).toContain(">Ctrl</kbd>");
  });

  test("lists the palette key with Command on a Mac", () => {
    expect(render(true, "mac")).toContain(">⌘</kbd>");
  });

  test("offers the switch that turns the shortcuts off", () => {
    expect(render()).toContain("ショートカットを無効にする");
  });

  test("leaves the switch unchecked while the shortcuts are on", () => {
    expect(checkboxTag(render(true))).not.toContain("checked");
  });

  test("checks the switch while the shortcuts are off", () => {
    expect(checkboxTag(render(false))).toContain("checked");
  });

  test("says what stays available while they are off", () => {
    expect(render(false)).toContain("コマンドパレットとこの一覧は使えます");
  });

  test("has a close button", () => {
    expect(render()).toMatch(/<button[^>]*>閉じる<\/button>/);
  });
});
