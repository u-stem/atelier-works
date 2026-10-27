import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { ApiFailure } from "../../api/errors.ts";
import {
  freshQuery,
  loadingQuery,
  staleQuery,
} from "../../api/fakeSectionQuery.testing.ts";
import type { PipelineRow } from "../../api/guards/pipeline.ts";
import { PipelineSection } from "./PipelineSection.tsx";

const NOTICE = "前回取得した値を表示しています";
const NO_ROWS: PipelineRow[] = [];

function render(element: ReactElement): string {
  return renderToStaticMarkup(<MemoryRouter>{element}</MemoryRouter>);
}

describe("PipelineSection", () => {
  test("says the rows are stale after a failed refetch", () => {
    const query = staleQuery(NO_ROWS, new ApiFailure({ kind: "network" }));
    expect(
      render(
        <PipelineSection
          scope="active"
          onScopeChange={() => undefined}
          pipeline={query}
        />,
      ),
    ).toContain(NOTICE);
  });

  test("does not say the rows are stale for a 401", () => {
    const query = staleQuery(NO_ROWS, new ApiFailure({ kind: "unauthorized" }));
    expect(
      render(
        <PipelineSection
          scope="active"
          onScopeChange={() => undefined}
          pipeline={query}
        />,
      ),
    ).not.toContain(NOTICE);
  });

  test("does not say the rows are stale without a failure", () => {
    expect(
      render(
        <PipelineSection
          scope="active"
          onScopeChange={() => undefined}
          pipeline={freshQuery(NO_ROWS)}
        />,
      ),
    ).not.toContain(NOTICE);
  });
});

describe("PipelineSection while loading", () => {
  test("shows only the frame in the first moment", () => {
    expect(
      render(
        <PipelineSection
          scope="active"
          onScopeChange={() => undefined}
          pipeline={loadingQuery<PipelineRow[]>()}
        />,
      ),
    ).not.toContain("読み込み中");
  });

  test("holds the height of the table in the first moment", () => {
    expect(
      render(
        <PipelineSection
          scope="active"
          onScopeChange={() => undefined}
          pipeline={loadingQuery<PipelineRow[]>()}
        />,
      ),
    ).toContain("h-[3.375rem]");
  });
});

describe("PipelineSection pointer to the inbox", () => {
  test("leaves out the pointer that repeats the sidebar badge", () => {
    expect(
      render(
        <PipelineSection
          scope="active"
          onScopeChange={() => undefined}
          pipeline={freshQuery(NO_ROWS)}
        />,
      ),
    ).not.toContain("対応が必要なもの");
  });

  test("leaves out the pointer while the rows load", () => {
    expect(
      render(
        <PipelineSection
          scope="active"
          onScopeChange={() => undefined}
          pipeline={loadingQuery<PipelineRow[]>()}
        />,
      ),
    ).not.toContain("対応が必要なもの");
  });
});

describe("PipelineSection heading", () => {
  test("leaves out the heading that repeats the tab name", () => {
    expect(
      render(
        <PipelineSection
          scope="active"
          onScopeChange={() => undefined}
          pipeline={freshQuery(NO_ROWS)}
        />,
      ),
    ).not.toContain("<h2");
  });
});
