import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "../components/ui/tooltip.tsx";
import { PAGE_HEADER_CLASS } from "../lib/layoutClasses.ts";
import { PAGE_HEADING_ID } from "../lib/routeFocus.ts";
import { PageHeader } from "./PageHeader.tsx";
import type { RefreshStatus } from "./refreshStatus.ts";

const REFRESH: RefreshStatus = {
  updatedAt: 0,
  isFetching: false,
  isError: false,
  onRefresh: () => undefined,
  autoRefreshMs: null,
};

function render(label: string | null = null): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      {label === null ? (
        <PageHeader title="題" refresh={REFRESH} />
      ) : (
        <PageHeader title="題" refresh={REFRESH} refreshLabel={label} />
      )}
    </TooltipProvider>,
  );
}

const REFRESH_BUTTON = 'aria-label="この画面を更新"';
const ACTIONS = "<span>操作</span>";

// actionsがあるときに、右側の塊を開くタグ。右端への寄せはこの塊のクラスで決まる。
const ACTIONS_BLOCK_OPEN =
  '<div class="ml-auto flex flex-wrap items-center justify-end gap-x-4 gap-y-2">';

// 題を含む左のブロックの閉じタグの直後の位置。
// childrenにdivを含む要素を渡すと、先に現れる閉じタグを拾って誤るので、divを含まないchildrenだけで使う。
function titleBlockEnd(markup: string): number {
  return markup.indexOf("</div>", markup.indexOf("</h1>")) + "</div>".length;
}

function renderWith(options: {
  refresh?: RefreshStatus;
  actions?: ReactNode;
  children?: ReactNode;
}): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <PageHeader
        title="題"
        actions={options.actions}
        {...(options.refresh === undefined ? {} : { refresh: options.refresh })}
      >
        {options.children}
      </PageHeader>
    </TooltipProvider>,
  );
}

describe("PageHeader", () => {
  test("names the refresh button for the whole screen by default", () => {
    expect(render()).toContain('aria-label="この画面を更新"');
  });

  test("names the refresh button with the given label", () => {
    expect(render("一覧を更新")).toContain('aria-label="一覧を更新"');
  });

  test("renders the actions", () => {
    const markup = renderWith({
      refresh: REFRESH,
      actions: <span>操作</span>,
    });

    expect(markup).toContain(ACTIONS);
  });

  test("places the actions outside the title block without a refresh status", () => {
    const markup = renderWith({ actions: <span>操作</span> });

    expect(markup.indexOf(ACTIONS)).toBeGreaterThan(titleBlockEnd(markup));
  });

  test("places the actions after the refresh button", () => {
    const markup = renderWith({
      refresh: REFRESH,
      actions: <span>操作</span>,
    });

    expect(markup.indexOf(ACTIONS)).toBeGreaterThan(
      markup.lastIndexOf(REFRESH_BUTTON),
    );
  });

  test("keeps the children inside the title block", () => {
    const markup = renderWith({
      refresh: REFRESH,
      actions: <span>操作</span>,
      children: <p>子</p>,
    });

    expect(markup.indexOf("<p>子</p>")).toBeLessThan(titleBlockEnd(markup));
  });

  test("renders nothing after the title block without refresh or actions", () => {
    const markup = renderWith({});

    expect(markup.slice(titleBlockEnd(markup))).toBe("</header>");
  });

  test("does not wrap the refresh block without actions", () => {
    const markup = renderWith({ refresh: REFRESH });

    expect(markup).toContain(
      '</div><div class="flex items-center gap-2 text-small',
    );
  });

  test("opens the right edge block just before the actions", () => {
    const markup = renderWith({ actions: <span>操作</span> });

    expect(markup).toContain(`${ACTIONS_BLOCK_OPEN}${ACTIONS}`);
  });

  test("opens the right edge block just before the refresh block", () => {
    const markup = renderWith({
      refresh: REFRESH,
      actions: <span>操作</span>,
    });

    expect(markup).toContain(
      `${ACTIONS_BLOCK_OPEN}<div class="flex items-center gap-2`,
    );
  });

  test("does not push the refresh block to the right edge without actions", () => {
    const markup = renderWith({ refresh: REFRESH });

    expect(markup).not.toContain("ml-auto");
  });

  test("renders the refresh button without actions", () => {
    const markup = renderWith({ refresh: REFRESH });

    expect(markup).toContain(REFRESH_BUTTON);
  });

  test("places the children after the title", () => {
    const markup = renderWith({ children: <p>子</p> });

    expect(markup.indexOf("<p>子</p>")).toBeGreaterThan(markup.indexOf("題"));
  });

  test("gives the heading the id the route focus looks for", () => {
    expect(render()).toContain(`<h1 id="${PAGE_HEADING_ID}"`);
  });

  test("lets a script focus the heading without adding it to the Tab order", () => {
    expect(render()).toContain('tabindex="-1"');
  });

  test("draws no outline for a mouse focus", () => {
    expect(render()).toContain("outline-none");
  });

  test("draws a thin ring on the heading for a keyboard focus", () => {
    expect(render()).toMatch(/<h1[^>]*focus-visible:ring-2/);
  });

  test("draws the band with the shared class", () => {
    expect(renderWith({})).toContain(`<header class="${PAGE_HEADER_CLASS}">`);
  });

  test("shows the subtitle in mono when asked", () => {
    const markup = renderToStaticMarkup(
      <PageHeader title="題" subtitle="0190a1b2" subtitleMono />,
    );

    expect(markup).toMatch(/<p class="[^"]*font-mono[^"]*">0190a1b2<\/p>/);
  });

  test("draws a pending subtitle row when the subtitle is not known yet", () => {
    const markup = renderToStaticMarkup(
      <PageHeader title="題" subtitlePending />,
    );

    expect(markup).toContain('data-part="subtitle-pending"');
  });

  test("draws the pending row as tall as a subtitle line of the real header", () => {
    const markup = renderToStaticMarkup(
      <PageHeader title="題" subtitlePending />,
    );

    expect(markup).toContain("h-[1.3rem]");
  });

  test("hides the pending row from the reading order", () => {
    const markup = renderToStaticMarkup(
      <PageHeader title="題" subtitlePending />,
    );

    expect(markup).toMatch(
      /aria-hidden="true"[^>]*data-part="subtitle-pending"|data-part="subtitle-pending"[^>]*aria-hidden="true"/,
    );
  });

  test("draws no pending row once the subtitle is known", () => {
    const markup = renderToStaticMarkup(
      <PageHeader title="題" subtitle="副題" subtitlePending />,
    );

    expect(markup).not.toContain("subtitle-pending");
  });

  test("shows the subtitle in the text face by default", () => {
    const markup = renderToStaticMarkup(
      <PageHeader title="題" subtitle="副題" />,
    );

    expect(markup).not.toContain("font-mono");
  });
});
