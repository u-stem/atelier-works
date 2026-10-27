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
