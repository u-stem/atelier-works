import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ConsoleSummary } from "../api/guards/summary.ts";
import { summaryQueryKey } from "../api/queries.ts";
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
      windmillLinks(render()).map((tag) =>
        tag.includes('rel="noopener noreferrer"'),
      ),
    ).toEqual([true, true]);
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
      themeButtons(render()).map((button) => button.includes("ダークにする")),
    ).toEqual([true, true]);
  });

  test("has no three-way theme group", () => {
    expect(render()).not.toContain("OSに合わせる");
  });
});

/** たたんだ状態(保存領域に`1`がある)で描く。bunのテストには`window`が無いので、読み出しだけを差し替える。 */
function renderCollapsed(): string {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: { getItem: () => "1" } },
    configurable: true,
    writable: true,
  });
  try {
    return render();
  } finally {
    Reflect.deleteProperty(globalThis, "window");
    if (original !== undefined) {
      Object.defineProperty(globalThis, "window", original);
    }
  }
}

/** サイドバー(`aside`)の部分だけ。ドロワーは常に広げた形なので、たたんだ形の確認から外す。 */
function asideOf(html: string): string {
  return html.slice(html.indexOf("<aside"));
}

describe("Sidebar when collapsed", () => {
  test("keeps the theme button, with its name for screen readers only", () => {
    expect(asideOf(renderCollapsed())).toContain(
      '<span class="sr-only">ダークにする</span>',
    );
  });

  test("keeps the Windmill link, with its name for screen readers only", () => {
    expect(asideOf(renderCollapsed())).toMatch(
      /<span class="sr-only">Windmill/,
    );
  });

  test("names the edge toggle as the one that expands the menu", () => {
    expect(asideOf(renderCollapsed())).toMatch(
      /<button[^>]*aria-label="メニューの開閉"[^>]*title="メニューを広げる"/,
    );
  });

  test("reports the collapsed state on the edge toggle", () => {
    expect(asideOf(renderCollapsed())).toMatch(
      /<button[^>]*aria-expanded="false"[^>]*aria-label="メニューの開閉"/,
    );
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

  test("shows the toggle always on a device that cannot hover", () => {
    expect(render()).toMatch(
      /<button[^>]*aria-label="メニューの開閉"[^>]*class="[^"]*\[@media\(hover:none\)\]:opacity-100/,
    );
  });

  test("shows the toggle at once when the keyboard focuses it", () => {
    expect(render()).toMatch(
      /<button[^>]*aria-label="メニューの開閉"[^>]*class="[^"]*focus-visible:transition-none/,
    );
  });

  test("places the toggle at the height the pointer set, centered in the edge by default", () => {
    expect(render()).toMatch(
      /<button[^>]*aria-label="メニューの開閉"[^>]*class="[^"]*top-\[clamp\(1rem,var\(--edge-y,50%\),/,
    );
  });

  test("clamps the toggle to the inside of the edge in the style", () => {
    expect(render()).toContain("calc(100%_-_1rem))]");
  });

  test("names the toggle for the mouse with the title, not a tooltip", () => {
    expect(render()).toMatch(
      /<button[^>]*aria-label="メニューの開閉"[^>]*title="メニューをたたむ"/,
    );
  });

  test("lights the edge line from the keyboard focus of the toggle", () => {
    expect(render()).toContain("group-has-[:focus-visible]/edge:opacity-60");
  });

  test("hides the toggle until the edge is hovered or focused", () => {
    expect(render()).toMatch(
      /<button[^>]*aria-label="メニューの開閉"[^>]*class="[^"]*opacity-0[^"]*group-hover\/edge:opacity-100[^"]*focus-visible:opacity-100/,
    );
  });
});

function summaryWith(kind: string | null): ConsoleSummary {
  const notices =
    kind === null
      ? []
      : [
          {
            notice_id: 1,
            kind,
            message: "m",
            resolved: false,
            created_at: "2026-11-08T00:00:00.000Z",
            severity: "action",
            resolvable: false,
          },
        ];
  return {
    counts: { approvals: 0, failures: 0, notices: notices.length },
    approvals: [],
    failures: [],
    notices,
  };
}

function renderWithSummary(summary: ConsoleSummary): string {
  const client = new QueryClient();
  client.setQueryData(summaryQueryKey, summary);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider>
          <Sidebar onOpenHelp={() => undefined} />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 入口へのリンク(aタグ全体)。広げた形のサイドバーとドロワーの2つがある。 */
function entranceLinks(html: string, href: string): string[] {
  return (html.match(/<a [^>]*>(?:(?!<\/a>).)*<\/a>/g) ?? []).filter(
    (link) =>
      link.includes(`href="${href}"`) && !link.includes('target="_blank"'),
  );
}

describe("Sidebar badge of the system entrance", () => {
  test("shows the count of the notices that the system screen resolves", () => {
    const links = entranceLinks(
      renderWithSummary(summaryWith("deploy_approval_required")),
      "/system",
    );

    expect(links.length).toBeGreaterThan(0);
    expect(
      links.every((link) => link.includes('>1<span class="sr-only">件')),
    ).toBe(true);
  });

  test("shows no badge when no such notice is open", () => {
    const links = entranceLinks(
      renderWithSummary(summaryWith("cleanup_db_failed")),
      "/system",
    );

    expect(links.some((link) => link.includes("件"))).toBe(false);
  });

  test("shows no badge before the summary is known", () => {
    expect(
      entranceLinks(render(), "/system").some((link) => link.includes("件")),
    ).toBe(false);
  });

  test("does not add the count to the total of the menu button, since the inbox already counts the notice", () => {
    expect(
      renderWithSummary(summaryWith("deploy_approval_required")),
    ).toContain('aria-label="メニューを開く(要対応1件)"');
  });

  test("keeps the badge of the inbox at the number of the notices", () => {
    const links = entranceLinks(
      renderWithSummary(summaryWith("deploy_approval_required")),
      "/",
    );

    expect(links.length).toBeGreaterThan(0);
    expect(
      links.every((link) => link.includes('>1<span class="sr-only">件')),
    ).toBe(true);
  });
});
