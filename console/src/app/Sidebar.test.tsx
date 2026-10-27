import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReleaseDescription } from "../lib/consoleStatus.ts";
import { ReleaseNote } from "./Sidebar.tsx";

const RELEASE: ReleaseDescription = {
  versionLabel: "版 0123456",
  checkedLabel: "3分前に確認",
  warning: null,
};

describe("ReleaseNote", () => {
  test("shows the version in mono", () => {
    expect(renderToStaticMarkup(<ReleaseNote release={RELEASE} />)).toMatch(
      /font-mono[^>]*>版 0123456</,
    );
  });

  test("shows the time of the check in the text face", () => {
    expect(renderToStaticMarkup(<ReleaseNote release={RELEASE} />)).toMatch(
      /<span class="tabular-nums">3分前に確認<\/span>/,
    );
  });

  test("shows no version when it is unknown", () => {
    expect(
      renderToStaticMarkup(
        <ReleaseNote release={{ ...RELEASE, versionLabel: null }} />,
      ),
    ).not.toContain("版");
  });
});
