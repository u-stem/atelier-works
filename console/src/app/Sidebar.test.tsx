import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { TooltipProvider } from "../components/ui/tooltip.tsx";
import type { ReleaseDescription } from "../lib/consoleStatus.ts";
import { ReleaseNote, Sidebar, WINDMILL_URL } from "./Sidebar.tsx";

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

/** WindmillのUIへのリンク(aタグ)の開始タグ。Consoleの概要の入口も`href="/"`なので、別タブで開くものに絞る。 */
function windmillLinks(html: string): string[] {
  return (html.match(/<a [^>]*>/g) ?? []).filter(
    (tag) =>
      tag.includes(`href="${WINDMILL_URL}"`) && tag.includes('target="_blank"'),
  );
}

describe("Sidebar Windmill link", () => {
  test("puts the link in the drawer and in the side bar", () => {
    expect(windmillLinks(render()).length).toBe(2);
  });

  test("opens in a new tab without leaking the opener", () => {
    expect(
      windmillLinks(render()).every(
        (tag) =>
          tag.includes('target="_blank"') &&
          tag.includes('rel="noopener noreferrer"'),
      ),
    ).toBe(true);
  });
});

/** テーマを入れ替えるボタンの開始タグ。ボタンの名前は、押したときに付く配色を示す。 */
function themeButtons(html: string): string[] {
  return (
    html.match(/<button[^>]*>(?:(?!<\/button>).)*<\/button>/g) ?? []
  ).filter((button) => /ダークにする|ライトにする/.test(button));
}

describe("Sidebar theme toggle", () => {
  test("puts a single theme button in the drawer and in the side bar", () => {
    expect(themeButtons(render()).length).toBe(2);
  });

  test("offers dark in the light screen", () => {
    expect(
      themeButtons(render()).every((b) => b.includes("ダークにする")),
    ).toBe(true);
  });

  test("has no three-way theme group", () => {
    expect(render()).not.toContain("OSに合わせる");
  });
});

describe("Sidebar edge toggle", () => {
  test("has a single toggle", () => {
    expect(render().match(/aria-label="メニューの開閉"/g)?.length).toBe(1);
  });

  test("reports the expanded state", () => {
    expect(render()).toMatch(
      /<button[^>]*aria-expanded="true"[^>]*aria-label="メニューの開閉"/,
    );
  });

  test("hides the toggle until the edge is hovered or focused", () => {
    expect(render()).toMatch(
      /<button[^>]*aria-label="メニューの開閉"[^>]*class="[^"]*opacity-0[^"]*group-hover\/edge:opacity-100[^"]*focus-visible:opacity-100/,
    );
  });
});
