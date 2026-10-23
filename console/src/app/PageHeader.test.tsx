import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "../components/ui/tooltip.tsx";
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

// 題を含む左のブロックの閉じタグの直後の位置。
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

  test("pushes the block holding the actions to the right edge", () => {
    const markup = renderWith({ actions: <span>操作</span> });

    expect(markup).toContain("ml-auto");
  });

  test("right aligns the contents of the block holding the actions", () => {
    const markup = renderWith({
      refresh: REFRESH,
      actions: <span>操作</span>,
    });

    expect(markup).toContain("justify-end");
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
});
