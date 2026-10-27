import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiFailure } from "../../api/errors.ts";
import {
  freshQuery,
  loadingQuery,
  staleQuery,
} from "../../api/fakeSectionQuery.testing.ts";
import type { SectionQuery } from "../../api/sectionQuery.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import { SYSTEM_SKELETONS, SystemSection } from "./SystemSection.tsx";

function render(query: SectionQuery<string>): string {
  return renderToStaticMarkup(
    <SystemSection
      id="x-heading"
      title="節"
      description="説明"
      query={query}
      loginHint="ログインしてください"
    >
      {(data) => <p>{data}</p>}
    </SystemSection>,
  );
}

describe("SystemSection", () => {
  test("shows the previous values", () => {
    expect(
      render(staleQuery("前の値", new ApiFailure({ kind: "network" }))),
    ).toContain("前の値");
  });

  test("says the values are stale after a failed refetch", () => {
    expect(
      render(staleQuery("前の値", new ApiFailure({ kind: "network" }))),
    ).toContain("前回取得した値を表示しています");
  });

  test("does not say the values are stale for a 401", () => {
    expect(
      render(staleQuery("前の値", new ApiFailure({ kind: "unauthorized" }))),
    ).not.toContain("前回取得した値を表示しています");
  });

  test("does not say the values are stale without a failure", () => {
    expect(render(freshQuery("前の値"))).not.toContain(
      "前回取得した値を表示しています",
    );
  });
});

function renderWithTime(updatedAt: number | undefined): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <SystemSection
        id="x-heading"
        title="節"
        description="説明"
        query={{ ...freshQuery("値"), dataUpdatedAt: updatedAt }}
        loginHint="ログインしてください"
      >
        {(data) => <p>{data}</p>}
      </SystemSection>
    </TooltipProvider>,
  );
}

describe("SystemSection time of the fetch", () => {
  test("leaves out the time that repeats the header", () => {
    expect(renderWithTime(Date.now() - 3 * 3_600_000)).not.toContain("<time");
  });

  test("leaves out the prefix of the time", () => {
    expect(renderWithTime(Date.now() - 3 * 3_600_000)).not.toContain("取得 ");
  });
});

describe("SystemSection heading", () => {
  test("can take the focus when a link jumps to the section", () => {
    expect(render(freshQuery("値"))).toMatch(
      /<h2 id="x-heading"[^>]*tabindex="-1"/,
    );
  });

  test("leaves room above the heading when scrolled to", () => {
    expect(render(freshQuery("値"))).toMatch(
      /<h2 id="x-heading"[^>]*class="[^"]*scroll-mt-/,
    );
  });
});

describe("SystemSection while loading", () => {
  test("shows only the frame in the first moment", () => {
    expect(render(loadingQuery<string>())).not.toContain("読み込み中");
  });
});

function sectionIdsIn(file: string): string[] {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  return [...source.matchAll(/id="([a-z-]+-heading)"/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

describe("SYSTEM_SKELETONS", () => {
  const ids = [
    ...sectionIdsIn("./SystemScreen.tsx"),
    ...sectionIdsIn("./HoldsSection.tsx"),
  ];

  test("finds the sections of the screen", () => {
    expect(ids.length).toBeGreaterThan(0);
  });

  test.each(ids)("gives %s a frame sized to its content", (id) => {
    expect(SYSTEM_SKELETONS[id]).toBeDefined();
  });

  /** 同じ高さの行を並べる形の、行のclass。 */
  function rowClassOf(id: string): string {
    const shape = SYSTEM_SKELETONS[id];
    return shape !== undefined && "rowClassName" in shape
      ? shape.rowClassName
      : "";
  }

  test("sizes the worker load card to its headline and the fold", () => {
    expect(rowClassOf("worker-load-heading")).toContain("h-[6.125rem]");
  });

  test("sizes the update history to its three entries and the button", () => {
    expect(rowClassOf("update-history-heading")).toContain("h-[33rem]");
  });
});
