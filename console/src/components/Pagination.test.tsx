import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Pagination } from "./Pagination.tsx";

function render(page: number, total: number, size = 25): string {
  return renderToStaticMarkup(
    <Pagination
      page={page}
      total={total}
      size={size}
      onPageChange={() => {}}
      label="一覧のページ送り"
    />,
  );
}

/** `前へ`か`次へ`のボタンの開始タグ。 */
function buttonTag(html: string, text: string): string {
  return new RegExp(`<button [^>]*>${text}</button>`).exec(html)?.[0] ?? "";
}

/** `aria-disabled`を持たない、描かれたボタンの開始タグ。 */
const AVAILABLE = /^<button (?![^>]*\saria-disabled=")[^>]*>/;

/** `disabled`属性を持たない、描かれたボタンの開始タグ。 */
const NO_DISABLED = /^<button (?![^>]*\sdisabled[\s=>])[^>]*>/;

describe("Pagination", () => {
  test("draws nothing when the items fit one page", () => {
    expect(render(0, 25)).toBe("");
  });

  test("draws nothing for an empty list", () => {
    expect(render(0, 0)).toBe("");
  });

  test("draws a navigation named by the label", () => {
    expect(render(0, 60)).toContain('<nav aria-label="一覧のページ送り"');
  });

  test("shows the current page and the page count", () => {
    expect(render(1, 130)).toContain("2 / 6ページ");
  });

  test("shows the range of the current page", () => {
    expect(render(1, 130)).toContain("26–50件目 / 130件");
  });

  test("announces the range politely", () => {
    expect(render(1, 130)).toMatch(
      /<[a-z]+ [^>]*aria-live="polite"[^>]*>26–50件目 \/ 130件</,
    );
  });

  test("draws the last page for a page past the end", () => {
    expect(render(99, 130)).toContain("6 / 6ページ");
  });

  test("marks the previous button as unavailable on the first page", () => {
    expect(buttonTag(render(0, 60), "前へ")).toContain('aria-disabled="true"');
  });

  test("marks the next button as unavailable on the last page", () => {
    expect(buttonTag(render(2, 60), "次へ")).toContain('aria-disabled="true"');
  });

  test("keeps the next button available before the last page", () => {
    expect(buttonTag(render(1, 60), "次へ")).toMatch(AVAILABLE);
  });

  test("keeps the previous button available after the first page", () => {
    expect(buttonTag(render(1, 60), "前へ")).toMatch(AVAILABLE);
  });

  test("does not use the disabled attribute so focus stays on the button", () => {
    expect(buttonTag(render(0, 60), "前へ")).toMatch(NO_DISABLED);
  });

  test("draws the buttons as type button", () => {
    expect(buttonTag(render(0, 60), "次へ")).toContain('type="button"');
  });
});
