import { describe, expect, test } from "bun:test";
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

describe("PageHeader", () => {
  test("names the refresh button for the whole screen by default", () => {
    expect(render()).toContain('aria-label="この画面を更新"');
  });

  test("names the refresh button with the given label", () => {
    expect(render("一覧を更新")).toContain('aria-label="一覧を更新"');
  });
});
