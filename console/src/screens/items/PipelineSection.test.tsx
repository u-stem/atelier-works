import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiFailure } from "../../api/errors.ts";
import {
  freshQuery,
  loadingQuery,
  pausedQuery,
  staleQuery,
} from "../../api/fakeSectionQuery.testing.ts";
import type { PipelineRow } from "../../api/guards/pipeline.ts";
import { OFFLINE_WAIT_TEXT } from "../../components/LoadingState.tsx";
import { PipelineSection } from "./PipelineSection.tsx";

const NOTICE = "前回取得した値を表示しています";
const NO_ROWS: PipelineRow[] = [];

describe("PipelineSection", () => {
  test("says the rows are stale after a failed refetch", () => {
    const query = staleQuery(NO_ROWS, new ApiFailure({ kind: "network" }));
    expect(
      renderToStaticMarkup(<PipelineSection pipeline={query} />),
    ).toContain(NOTICE);
  });

  test("does not say the rows are stale for a 401", () => {
    const query = staleQuery(NO_ROWS, new ApiFailure({ kind: "unauthorized" }));
    expect(
      renderToStaticMarkup(<PipelineSection pipeline={query} />),
    ).not.toContain(NOTICE);
  });

  test("does not say the rows are stale without a failure", () => {
    expect(
      renderToStaticMarkup(<PipelineSection pipeline={freshQuery(NO_ROWS)} />),
    ).not.toContain(NOTICE);
  });
});

describe("PipelineSection while loading", () => {
  test("shows only the frame in the first moment", () => {
    expect(
      renderToStaticMarkup(
        <PipelineSection pipeline={loadingQuery<PipelineRow[]>()} />,
      ),
    ).not.toContain("読み込み中");
  });

  test("holds the height of the table in the first moment", () => {
    expect(
      renderToStaticMarkup(
        <PipelineSection pipeline={loadingQuery<PipelineRow[]>()} />,
      ),
    ).toContain("h-12");
  });

  test("tells the user that the fetch waits for the network", () => {
    expect(
      renderToStaticMarkup(
        <PipelineSection pipeline={pausedQuery<PipelineRow[]>()} />,
      ),
    ).toContain(OFFLINE_WAIT_TEXT);
  });
});
