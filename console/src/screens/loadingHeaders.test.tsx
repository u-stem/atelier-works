// 最初の取得を待つ間の見出しが、取得後の見出しと同じ高さになることを確かめる。
// 副題は取得後に出るので、待つ間は副題の行を空けておく。空けないと、取得が終わった瞬間に、下の本文が約21px動く。

import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { TooltipProvider } from "../components/ui/tooltip.tsx";
import { ItemDetailScreen } from "./items/ItemDetailScreen.tsx";
import { ItemRequirementsScreen } from "./items/ItemRequirementsScreen.tsx";
import { BackLink } from "./items/NewItemScreen.tsx";
import { AuditReportScreen } from "./reports/AuditReportScreen.tsx";

const PENDING = 'data-part="subtitle-pending"';

function render(pattern: string, path: string, screen: ReactElement): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path={pattern} element={screen} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("the header before the first read", () => {
  test("the work item detail keeps a subtitle row", () => {
    expect(render("/items/:id", "/items/12", <ItemDetailScreen />)).toContain(
      PENDING,
    );
  });

  test("the requirements document keeps a subtitle row", () => {
    expect(
      render(
        "/items/:id/requirements",
        "/items/12/requirements",
        <ItemRequirementsScreen />,
      ),
    ).toContain(PENDING);
  });

  test("the audit report keeps a subtitle row", () => {
    expect(
      render("/reports/audit/:id", "/reports/audit/50", <AuditReportScreen />),
    ).toContain(PENDING);
  });

  test("a work item number that is not valid gets no pending row", () => {
    expect(
      render("/items/:id", "/items/abc", <ItemDetailScreen />),
    ).not.toContain(PENDING);
  });
});

/** 副題の行の中身が空(高さだけを確保している)。 */
const EMPTY_PENDING_ROW = /data-part="subtitle-pending"[^>]*><\/div>/;

describe("the header in the first moment of the loading", () => {
  // 取得が300ms続くまでは、本文の枠が空であるのと同じく、副題の行も空のまま高さだけを確保する。
  test("the work item detail keeps the subtitle row empty", () => {
    expect(render("/items/:id", "/items/12", <ItemDetailScreen />)).toMatch(
      EMPTY_PENDING_ROW,
    );
  });

  test("the requirements document keeps the subtitle row empty", () => {
    expect(
      render(
        "/items/:id/requirements",
        "/items/12/requirements",
        <ItemRequirementsScreen />,
      ),
    ).toMatch(EMPTY_PENDING_ROW);
  });

  test("the audit report keeps the subtitle row empty", () => {
    expect(
      render("/reports/audit/:id", "/reports/audit/50", <AuditReportScreen />),
    ).toMatch(EMPTY_PENDING_ROW);
  });
});

const CRUMB = 'aria-label="パンくず"';
const REFRESH = 'aria-label="この画面を更新"';

describe("the header before the first read draws what the loaded header draws", () => {
  test("the work item detail draws the breadcrumb", () => {
    expect(render("/items/:id", "/items/12", <ItemDetailScreen />)).toContain(
      CRUMB,
    );
  });

  test("the requirements document draws the breadcrumb", () => {
    expect(
      render(
        "/items/:id/requirements",
        "/items/12/requirements",
        <ItemRequirementsScreen />,
      ),
    ).toContain(CRUMB);
  });

  test("the audit report draws the breadcrumb", () => {
    expect(
      render("/reports/audit/:id", "/reports/audit/50", <AuditReportScreen />),
    ).toContain(CRUMB);
  });

  test("the audit report draws the refresh control", () => {
    expect(
      render("/reports/audit/:id", "/reports/audit/50", <AuditReportScreen />),
    ).toContain(REFRESH);
  });

  // 新規投入の画面は、入力の保存の購読を持ち、サーバー描画できない。戻りのリンクだけを描いて確かめる。
  test("the new item screen draws the link back to the list", () => {
    expect(render("/items/new", "/items/new", <BackLink />)).toContain(
      'href="/items"',
    );
  });
});
