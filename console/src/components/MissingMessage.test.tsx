import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MissingMessage } from "./MissingMessage.tsx";

describe("MissingMessage", () => {
  test("shows the given sentence", () => {
    expect(
      renderToStaticMarkup(<MissingMessage>見つかりません。</MissingMessage>),
    ).toContain("見つかりません。");
  });

  test("does not say the screen is in preparation", () => {
    expect(
      renderToStaticMarkup(<MissingMessage>見つかりません。</MissingMessage>),
    ).not.toContain("準備中です");
  });
});
