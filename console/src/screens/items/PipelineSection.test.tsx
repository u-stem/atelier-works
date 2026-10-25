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
    ).toContain("h-12");
  });
});

describe("PipelineSection pointer to the inbox", () => {
  const NOTE = "対応が必要なものは『要対応』にあります";

  test("says how many items need action", () => {
    expect(
      render(
        <PipelineSection
          scope="active"
          onScopeChange={() => undefined}
          pipeline={freshQuery(NO_ROWS)}
          actionableCount={3}
        />,
      ),
    ).toContain(`${NOTE}(3件)`);
  });

  test("links to the inbox", () => {
    expect(
      render(
        <PipelineSection
          scope="active"
          onScopeChange={() => undefined}
          pipeline={freshQuery(NO_ROWS)}
          actionableCount={3}
        />,
      ),
    ).toMatch(/<a [^>]*href="\/"[^>]*>対応が必要なもの/);
  });

  test("leaves the count out while it is unknown", () => {
    expect(
      render(
        <PipelineSection
          scope="active"
          onScopeChange={() => undefined}
          pipeline={freshQuery(NO_ROWS)}
          actionableCount={null}
        />,
      ),
    ).not.toContain("件)");
  });

  test("shows the pointer while the rows load", () => {
    expect(
      render(
        <PipelineSection
          scope="active"
          onScopeChange={() => undefined}
          pipeline={loadingQuery<PipelineRow[]>()}
          actionableCount={2}
        />,
      ),
    ).toContain(NOTE);
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
