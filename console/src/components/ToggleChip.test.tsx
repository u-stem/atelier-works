import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToggleChip, ToggleChipGroup } from "./ToggleChip.tsx";

function chip(pressed: boolean, className?: string): string {
  return renderToStaticMarkup(
    <ToggleChip pressed={pressed} aria-label="ライト" className={className}>
      ラベル
    </ToggleChip>,
  );
}

function classesOf(html: string): string[] {
  return (/class="([^"]*)"/.exec(html)?.[1] ?? "").split(" ");
}

describe("ToggleChip", () => {
  test("marks the pressed chip with aria-pressed true", () => {
    expect(chip(true)).toContain('aria-pressed="true"');
  });

  test("marks the unpressed chip with aria-pressed false", () => {
    expect(chip(false)).toContain('aria-pressed="false"');
  });

  test("does not submit a form", () => {
    expect(chip(false)).toContain('type="button"');
  });

  test("passes the other attributes to the button", () => {
    expect(chip(false)).toContain('aria-label="ライト"');
  });

  test("adds the class of the caller", () => {
    expect(classesOf(chip(false, "size-7"))).toContain("size-7");
  });

  test.each(["border-primary", "bg-selected", "text-selected-foreground"])(
    "gives the pressed chip %s",
    (token) => {
      expect(classesOf(chip(true))).toContain(token);
    },
  );

  test("keeps the border of the unpressed chip transparent", () => {
    expect(classesOf(chip(false))).toContain("border-transparent");
  });

  test("does not give the unpressed chip the selected border", () => {
    expect(classesOf(chip(false))).not.toContain("border-primary");
  });

  test("moves the focus ring off the border", () => {
    expect(classesOf(chip(false))).toContain("focus-visible:ring-offset-1");
  });

  test("lets the caller replace the text color of the unpressed chip", () => {
    expect(classesOf(chip(false, "text-subtle"))).not.toContain(
      "text-muted-foreground",
    );
  });
});

describe("ToggleChipGroup", () => {
  const group = renderToStaticMarkup(
    <ToggleChipGroup legend="テーマ">
      <span>中身</span>
    </ToggleChipGroup>,
  );

  test("is a fieldset", () => {
    expect(group).toMatch(/^<fieldset /);
  });

  test("names the group with a legend only screen readers see", () => {
    expect(group).toContain('<legend class="sr-only">テーマ</legend>');
  });

  test("holds the chips", () => {
    expect(group).toContain("<span>中身</span>");
  });
});
