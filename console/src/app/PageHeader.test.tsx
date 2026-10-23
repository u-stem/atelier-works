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

    expect(markup).toContain("<span>操作</span>");
  });

  test("renders the actions without a refresh status", () => {
    const markup = renderWith({ actions: <span>操作</span> });

    expect(markup).toContain("<span>操作</span>");
  });

  test("places the actions after the refresh button", () => {
    const markup = renderWith({
      refresh: REFRESH,
      actions: <span>操作</span>,
    });

    expect(markup.indexOf("<span>操作</span>")).toBeGreaterThan(
      markup.lastIndexOf(REFRESH_BUTTON),
    );
  });

  test("keeps the children on the title side", () => {
    const markup = renderWith({
      refresh: REFRESH,
      actions: <span>操作</span>,
      children: <p>子</p>,
    });

    expect(markup.indexOf("<p>子</p>")).toBeLessThan(
      markup.indexOf(REFRESH_BUTTON),
    );
  });

  test("renders no refresh text without refresh or actions", () => {
    const markup = renderWith({});

    expect(markup).not.toContain("更新");
  });

  test("renders no right side block without refresh or actions", () => {
    const markup = renderWith({});

    expect(markup.split("<div").length - 1).toBe(1);
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
