import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { TooltipProvider } from "../components/ui/tooltip.tsx";
import type { ReleaseDescription } from "../lib/consoleStatus.ts";
import { ReleaseNote, Sidebar } from "./Sidebar.tsx";

const RELEASE: ReleaseDescription = {
  versionSha: "0123456",
  checkedLabel: "3分前に確認",
  warning: null,
};

function renderRelease(release: ReleaseDescription): string {
  return renderToStaticMarkup(<ReleaseNote release={release} />);
}

describe("ReleaseNote", () => {
  test("shows the sha in mono", () => {
    expect(renderRelease(RELEASE)).toMatch(
      /<span class="[^"]*font-mono[^"]*">0123456<\/span>/,
    );
  });

  test("shows the word for the version in the text face", () => {
    expect(renderRelease(RELEASE)).toMatch(/版 <span class="[^"]*font-mono/);
  });

  test("does not put the word for the version into the mono span", () => {
    expect(renderRelease(RELEASE)).not.toMatch(/font-mono[^>]*>[^<]*版/);
  });

  test("shows the time of the check in the text face", () => {
    expect(renderRelease(RELEASE)).toMatch(
      /<span class="tabular-nums">3分前に確認<\/span>/,
    );
  });

  test("shows no version when it is unknown", () => {
    expect(renderRelease({ ...RELEASE, versionSha: null })).not.toContain("版");
  });
});

function render(): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <TooltipProvider>
          <Sidebar onOpenHelp={() => undefined} />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 「ショートカット」の名前を持つボタンの開始タグ。 */
function helpButtons(html: string): string[] {
  return (
    html.match(/<button[^>]*>(?:(?!<\/button>).)*<\/button>/g) ?? []
  ).filter((button) => button.includes("ショートカット"));
}

describe("Sidebar", () => {
  test("help: opens from the sidebar button, which names the shortcuts", () => {
    expect(helpButtons(render()).length).toBeGreaterThan(0);
  });

  test("announces that the button opens a dialog", () => {
    expect(
      helpButtons(render()).every((button) =>
        button.includes('aria-haspopup="dialog"'),
      ),
    ).toBe(true);
  });

  test("puts the button in the drawer and in the side bar", () => {
    expect(helpButtons(render()).length).toBe(2);
  });
});
