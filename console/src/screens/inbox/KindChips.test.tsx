import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { KindChips } from "./KindChips.tsx";

const CHIPS = [
  { id: "all", label: "すべて" },
  { id: "approval", label: "承認" },
] as const;

/** 描画した各ボタンのクラスを、aria-pressedの値ごとに取り出す。 */
function classesByPressed(active: "all" | "approval"): {
  pressed: string[];
  unpressed: string[];
} {
  const html = renderToStaticMarkup(
    <KindChips
      chips={CHIPS}
      counts={{ all: 3, approval: 1, failure: 0, notice: 2 }}
      active={active}
      onChange={() => undefined}
    />,
  );
  const result: { pressed: string[]; unpressed: string[] } = {
    pressed: [],
    unpressed: [],
  };
  for (const tag of html.matchAll(/<button[^>]*>/g)) {
    const classes = /class="([^"]*)"/.exec(tag[0])?.[1] ?? "";
    const target = tag[0].includes('aria-pressed="true"')
      ? result.pressed
      : result.unpressed;
    target.push(...classes.split(" "));
  }
  return result;
}

describe("KindChips selection style", () => {
  test.each(["border-primary", "bg-selected", "text-selected-foreground"])(
    "gives the pressed chip %s",
    (token) => {
      expect(classesByPressed("approval").pressed).toContain(token);
    },
  );

  test("keeps the border of the unpressed chip transparent", () => {
    expect(classesByPressed("approval").unpressed).toContain(
      "border-transparent",
    );
  });

  test("does not give the unpressed chip the selected border", () => {
    expect(classesByPressed("approval").unpressed).not.toContain(
      "border-primary",
    );
  });

  test("moves the focus ring off the border", () => {
    expect(classesByPressed("approval").unpressed).toContain(
      "focus-visible:ring-offset-1",
    );
  });
});
