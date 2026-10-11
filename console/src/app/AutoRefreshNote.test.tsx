import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AutoRefreshNote } from "./AutoRefreshNote.tsx";

describe("AutoRefreshNote", () => {
  test("shows nothing when the screen is not refreshed automatically", () => {
    expect(
      renderToStaticMarkup(
        <AutoRefreshNote intervalMs={null} failed={false} />,
      ),
    ).toBe("");
  });

  test("shows the interval in full-width parentheses", () => {
    expect(
      renderToStaticMarkup(
        <AutoRefreshNote intervalMs={120_000} failed={false} />,
      ),
    ).toContain("（2分ごとに自動更新）");
  });

  test("says it retries automatically while the fetch has failed", () => {
    expect(
      renderToStaticMarkup(
        <AutoRefreshNote intervalMs={120_000} failed={true} />,
      ),
    ).toContain("（2分ごとに自動で再試行）");
  });

  test("does not say it refreshes while the fetch has failed", () => {
    expect(
      renderToStaticMarkup(
        <AutoRefreshNote intervalMs={120_000} failed={true} />,
      ),
    ).not.toContain("自動更新");
  });
});
