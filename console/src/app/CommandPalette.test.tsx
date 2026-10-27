import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { CommandPalette } from "./CommandPalette.tsx";

function render(): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <CommandPalette
        open={false}
        onClose={() => undefined}
        onOpenHelp={() => undefined}
      />
    </MemoryRouter>,
  );
}

/** 開始タグの属性の値。無ければ`null`。 */
function attributeOf(tag: string, name: string): string | null {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
}

function tagWith(html: string, marker: string): string {
  return new RegExp(`<[a-z]+ [^>]*${marker}[^>]*>`).exec(html)?.[0] ?? "";
}

function optionTags(html: string): string[] {
  return html.match(/<[a-z]+ [^>]*role="option"[^>]*>/g) ?? [];
}

describe("CommandPalette", () => {
  test("is a dialog that the keyboard rules can recognize", () => {
    expect(render()).toContain("data-command-palette");
  });

  test("names the dialog", () => {
    expect(
      attributeOf(tagWith(render(), "data-command-palette"), "aria-label"),
    ).toBe("コマンドパレット");
  });

  test("lists the five screens, their four fixed destinations and the help as options", () => {
    expect(optionTags(render()).length).toBe(10);
  });

  test("names a fixed destination that the side bar does not reach in one click", () => {
    expect(render()).toContain("ジョブ › スケジュール");
  });

  test("draws the two group headings", () => {
    expect(
      [...render().matchAll(/data-group-heading[^>]*>([^<]*)</g)].map(
        (match) => match[1],
      ),
    ).toEqual(["画面", "ヘルプ"]);
  });

  test("names the help item", () => {
    expect(render()).toContain("ショートカットの一覧を開く");
  });

  test("takes the screen names from the table", () => {
    expect(render()).toContain("作業項目");
  });

  test("keeps the focus in the input, which is a combobox", () => {
    expect(tagWith(render(), 'role="combobox"')).toContain("<input");
  });

  test("shows that the list is open", () => {
    expect(
      attributeOf(tagWith(render(), 'role="combobox"'), "aria-expanded"),
    ).toBe("true");
  });

  test("points the combobox at the listbox", () => {
    const html = render();
    expect(attributeOf(tagWith(html, 'role="combobox"'), "aria-controls")).toBe(
      attributeOf(tagWith(html, 'role="listbox"'), "id"),
    );
  });

  test("marks the first option as the active descendant", () => {
    const html = render();
    expect(
      attributeOf(tagWith(html, 'role="combobox"'), "aria-activedescendant"),
    ).toBe(attributeOf(optionTags(html)[0] ?? "", "id"));
  });

  test("selects only the first option", () => {
    expect(
      optionTags(render()).map((tag) => attributeOf(tag, "aria-selected")),
    ).toEqual(["true", ...Array.from({ length: 9 }, () => "false")]);
  });

  test("gives every option its own id", () => {
    const ids = optionTags(render()).map((tag) => attributeOf(tag, "id"));
    expect(new Set(ids).size).toBe(10);
  });

  test("names the input", () => {
    expect(
      attributeOf(tagWith(render(), 'role="combobox"'), "aria-label"),
    ).toBe("画面やヘルプを探す");
  });

  test("reads the result count in a status only the readers see", () => {
    expect(tagWith(render(), 'role="status"')).toContain("sr-only");
  });

  test("reads the count of the results", () => {
    expect(render()).toMatch(/role="status"[^>]*>10件の候補</);
  });

  test("draws no key hint, because the shortcuts are off by default", () => {
    expect(render()).not.toContain("<kbd");
  });
});
