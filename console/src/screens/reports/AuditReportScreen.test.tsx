import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { auditDocQueryKey } from "../../api/auditQueries.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import { AuditReportScreen } from "./AuditReportScreen.tsx";

function render(path: string, client: QueryClient = new QueryClient()): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="reports/audit/:id" element={<AuditReportScreen />} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("AuditReportScreen with a malformed number", () => {
  const html = render("/reports/audit/abc");

  test("says the number is not valid", () => {
    expect(html).toContain("作業項目の番号が正しくありません。");
  });

  test("does not say the screen is in preparation", () => {
    expect(html).not.toContain("準備中です");
  });
});

describe("AuditReportScreen without a report", () => {
  const client = new QueryClient();
  client.setQueryData(auditDocQueryKey(7), null);
  const html = render("/reports/audit/7", client);

  test("says the report is not found", () => {
    expect(html).toContain("この作業項目の監査レポートは見つかりません。");
  });

  test("does not say the screen is in preparation", () => {
    expect(html).not.toContain("準備中です");
  });
});
