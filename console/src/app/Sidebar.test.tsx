import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReleaseDescription } from "../lib/consoleStatus.ts";
import { ReleaseNote } from "./Sidebar.tsx";

const RELEASE: ReleaseDescription = {
  versionSha: "0123456",
  checkedLabel: "3分前に確認",
  warning: null,
};

function render(release: ReleaseDescription): string {
  return renderToStaticMarkup(<ReleaseNote release={release} />);
}

describe("ReleaseNote", () => {
  test("shows the sha in mono", () => {
    expect(render(RELEASE)).toMatch(
      /<span class="[^"]*font-mono[^"]*">0123456<\/span>/,
    );
  });

  test("shows the word for the version in the text face", () => {
    expect(render(RELEASE)).toMatch(/版 <span class="[^"]*font-mono/);
  });

  test("does not put the word for the version into the mono span", () => {
    expect(render(RELEASE)).not.toMatch(/font-mono[^>]*>[^<]*版/);
  });

  test("shows the time of the check in the text face", () => {
    expect(render(RELEASE)).toMatch(
      /<span class="tabular-nums">3分前に確認<\/span>/,
    );
  });

  test("shows no version when it is unknown", () => {
    expect(render({ ...RELEASE, versionSha: null })).not.toContain("版");
  });
});
