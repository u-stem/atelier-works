import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReleaseNotice } from "../../lib/writeNotices.ts";
import { CONFIG_NOTICE_ID, ConfigNotice } from "./ConfigNotice.tsx";

const REFUSAL: ReleaseNotice = {
  tone: "info",
  message: "設定に変数かresourceへの参照があるため、変更しませんでした。",
  nextStep: "端末から変更します。済んだら、画面を更新して確かめます。",
};

/** 描く前の要素の木から、`onClick`を持つ要素の押したときの処理を、上から順に集める。 */
function pressesIn(node: unknown): (() => void)[] {
  if (Array.isArray(node)) return node.flatMap(pressesIn);
  if (typeof node !== "object" || node === null || !("props" in node)) {
    return [];
  }
  const props = node.props;
  if (typeof props !== "object" || props === null) return [];
  const click = "onClick" in props ? props.onClick : undefined;
  const own = typeof click === "function" ? [() => click()] : [];
  const inner = "children" in props ? pressesIn(props.children) : [];
  return [...own, ...inner];
}

function render(
  notice: ReleaseNotice,
  item = "implement_enabled",
  onClose: () => void = () => undefined,
): string {
  return renderToStaticMarkup(
    <ConfigNotice item={item} notice={notice} onClose={onClose} />,
  );
}

describe("ConfigNotice", () => {
  test("is an alert so that a reader of the screen hears it", () => {
    expect(render(REFUSAL)).toMatch(/<div[^>]*role="alert"/);
  });

  test("names the item that the change was about in the title of a refusal", () => {
    expect(render(REFUSAL)).toMatch(
      /<div[^>]*>implement_enabledの変更を断られました<\/div>/,
    );
  });

  test("gives the alert an id that the page can move the focus to", () => {
    expect(render(REFUSAL)).toMatch(
      new RegExp(
        `<div(?=[^>]*role="alert")(?=[^>]*id="${CONFIG_NOTICE_ID}")[^>]*>`,
      ),
    );
  });

  test("lets the alert take the focus without a place in the order of the Tab key", () => {
    expect(render(REFUSAL)).toMatch(
      /<div(?=[^>]*role="alert")(?=[^>]*tabindex="-1")[^>]*>/,
    );
  });

  test("says why the change was refused", () => {
    expect(render(REFUSAL)).toContain(REFUSAL.message);
  });

  test("tells the next step after a label", () => {
    expect(render(REFUSAL)).toMatch(
      /次の操作[:：][^<]*<\/span>\s*端末から変更します/,
    );
  });

  test("shows no next step when the notice has none", () => {
    expect(
      render({ tone: "warning", message: "Windmillで確かめてください。" }),
    ).not.toContain("次の操作");
  });

  test("asks to check a warning in the title", () => {
    expect(
      render({ tone: "warning", message: "読み直した値が期待と違います。" }),
    ).toContain("implement_enabledの変更を確かめてください");
  });

  test("says that an error failed in the title", () => {
    expect(
      render({ tone: "error", message: "接続できませんでした。" }),
    ).toContain("implement_enabledの変更に失敗しました");
  });

  test("has a button to close it", () => {
    expect(render(REFUSAL)).toMatch(/<button[^>]*>閉じる<\/button>/);
  });

  test("closes the notice when the button is pressed", () => {
    let closed = 0;
    const element = ConfigNotice({
      item: "implement_enabled",
      notice: REFUSAL,
      onClose: () => {
        closed += 1;
      },
    });
    pressesIn(element)[0]?.();
    expect(closed).toBe(1);
  });

  test("writes the item as text, not as markup", () => {
    expect(render(REFUSAL, "<b>x</b>")).not.toContain("<b>x</b>");
  });

  test("uses a quieter look for a refusal than for an error", () => {
    expect(render(REFUSAL)).not.toContain("text-destructive");
  });

  test("uses the look of an error for an error", () => {
    expect(render({ tone: "error", message: "m" })).toContain(
      "text-destructive",
    );
  });
});
