import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AutoRefreshNote } from "./AutoRefreshNote.tsx";

describe("AutoRefreshNote", () => {
  test("shows nothing when the screen is not refreshed automatically", () => {
    expect(renderToStaticMarkup(<AutoRefreshNote intervalMs={null} />)).toBe(
      "",
    );
  });

  test("shows the interval in full-width parentheses", () => {
    expect(
      renderToStaticMarkup(<AutoRefreshNote intervalMs={120_000} />),
    ).toContain("（2分ごとに自動更新）");
  });
});
