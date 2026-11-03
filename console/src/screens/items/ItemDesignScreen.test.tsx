import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import type { DesignDoc } from "../../api/guards/design.ts";
import { designDocQueryKey } from "../../api/queries.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import { ItemDesignScreen } from "./ItemDesignScreen.tsx";

const DOC: DesignDoc = {
  id: 21,
  work_item_id: 7,
  requirement_draft_id: 11,
  owner: "o",
  repo: "r",
  requirement_attempt: 2,
  design_attempt: 1,
  summary: "Summary line",
  markdown: "# Design title\n\n## Background\n\nBody paragraph.\n",
  diagrams: [],
  rejected_diagrams: [],
  open_questions: [],
  created_at: "2026-11-01T00:00:00.000Z",
  approval_request_id: null,
  approval_status: null,
};

const NOT_FOUND = "この設計書は見つかりません";

type Seed = { readonly draftId: number | null; readonly doc: DesignDoc | null };

function render(url: string, seed?: Seed): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (seed !== undefined) {
    client.setQueryData(designDocQueryKey(7, seed.draftId), seed.doc);
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path="/items/:id/design" element={<ItemDesignScreen />} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("ItemDesignScreen", () => {
  test("draws the latest design without a draft", () => {
    expect(render("/items/7/design", { draftId: null, doc: DOC })).toContain(
      "Body paragraph.",
    );
  });

  test("draws the design of the draft in the query", () => {
    expect(
      render("/items/7/design?draft=21", { draftId: 21, doc: DOC }),
    ).toContain("Body paragraph.");
  });

  test("takes the heading from the title of the body", () => {
    expect(render("/items/7/design", { draftId: null, doc: DOC })).toContain(
      "Design title",
    );
  });

  test("names the design in the subtitle", () => {
    expect(render("/items/7/design", { draftId: null, doc: DOC })).toContain(
      "要件定義 試行 2・設計 試行 1",
    );
  });

  test("shows one sentence for a draft that is not found", () => {
    expect(
      render("/items/7/design?draft=99", { draftId: 99, doc: null }),
    ).toContain(NOT_FOUND);
  });

  test("shows one sentence for a work item without a design", () => {
    expect(render("/items/7/design", { draftId: null, doc: null })).toContain(
      NOT_FOUND,
    );
  });

  test("shows one sentence for a draft that is not a number", () => {
    expect(render("/items/7/design?draft=abc")).toContain(NOT_FOUND);
  });

  test("shows one sentence for a draft of zero", () => {
    expect(render("/items/7/design?draft=0")).toContain(NOT_FOUND);
  });

  test("shows one sentence for a work item number that is not valid", () => {
    expect(render("/items/abc/design")).toContain(
      "作業項目の番号が正しくありません",
    );
  });

  test("draws the breadcrumb that returns to the design tab", () => {
    expect(render("/items/7/design", { draftId: null, doc: DOC })).toContain(
      'href="/items/7?tab=design"',
    );
  });
});
