import { describe, expect, test } from "bun:test";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ViewMode } from "../lib/requirementsView.ts";
import { ViewModeSwitch } from "./ViewModeSwitch.tsx";

function html(mode: ViewMode): string {
  return renderToStaticMarkup(
    <ViewModeSwitch target="設計書" mode={mode} onChange={() => undefined} />,
  );
}

/** 描いた各ボタンのaria-pressedの値を、並び順で取り出す。 */
function pressedOf(markup: string): string[] {
  return Array.from(markup.matchAll(/<button[^>]*aria-pressed="(\w+)"/g)).map(
    (match) => match[1] ?? "",
  );
}

/** 関数として呼んだ`ViewModeSwitch`の、選択肢のボタンの押したときの処理を並び順で返す。 */
function clickHandlers(onChange: (mode: ViewMode) => void): (() => void)[] {
  const group = ViewModeSwitch({ target: "設計書", mode: "preview", onChange });
  return Children.toArray(group.props.children).flatMap((child) => {
    if (!isValidElement(child)) {
      return [];
    }
    const props: unknown = child.props;
    if (
      typeof props === "object" &&
      props !== null &&
      "onClick" in props &&
      typeof props.onClick === "function"
    ) {
      const handler = props.onClick;
      return [() => handler()];
    }
    return [];
  });
}

describe("ViewModeSwitch", () => {
  test("renders the two choices with aria-pressed", () => {
    expect(pressedOf(html("preview"))).toEqual(["true", "false"]);
  });

  test("marks the text choice when the text mode is chosen", () => {
    expect(pressedOf(html("text"))).toEqual(["false", "true"]);
  });

  test("names the choices", () => {
    expect(html("preview")).toMatch(/プレビュー[\s\S]*Markdownの文字/);
  });

  test("puts the target in the legend", () => {
    expect(html("preview")).toContain(
      '<legend class="sr-only">設計書の表示の形式</legend>',
    );
  });

  test("passes the chosen mode to onChange", () => {
    const chosen: ViewMode[] = [];
    const handlers = clickHandlers((mode) => {
      chosen.push(mode);
    });
    for (const handler of handlers) {
      handler();
    }
    expect(chosen).toEqual(["preview", "text"]);
  });
});
