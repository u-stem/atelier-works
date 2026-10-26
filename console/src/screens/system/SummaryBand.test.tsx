import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import { formatAbsoluteIso } from "../../lib/relativeTime.ts";
import type {
  BandLevel,
  BandRow,
  BandRowState,
} from "../../lib/summaryBand.ts";
import { SummaryBand } from "./SummaryBand.tsx";

const NOW = Date.parse("2026-10-26T03:00:00.000Z");
const FETCHED_AT = Date.parse("2026-10-26T02:57:00.000Z");

function row(
  id: BandRow["id"],
  level: BandLevel,
  overrides: Partial<BandRow> = {},
): BandRow {
  return {
    id,
    label: `ラベル ${id}`,
    level,
    text: `結論 ${id}`,
    count: null,
    countAtLeast: false,
    state: "ready",
    stale: false,
    target: { kind: "section", tab: "status", targetId: `${id}-heading` },
    ...overrides,
  };
}

function render(rows: BandRow[], updatedAt = 0): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>
        <SummaryBand
          rows={rows}
          onJump={() => undefined}
          now={NOW}
          updatedAt={updatedAt}
        />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe("SummaryBand", () => {
  test("is a navigation landmark named by its heading", () => {
    expect(render([row("holds", "normal")])).toMatch(
      /<nav[^>]*aria-labelledby="summary-band-heading"/,
    );
  });

  test("has a heading that only assistive technology reads", () => {
    expect(render([row("holds", "normal")])).toMatch(
      /<h2 id="summary-band-heading"[^>]*class="[^"]*sr-only[^"]*"[^>]*>要約/,
    );
  });

  test("lists one item for each chip", () => {
    expect(
      render([row("holds", "normal"), row("failures", "caution")]).match(
        /<li[ >]/g,
      ),
    ).toHaveLength(2);
  });

  test("links a chip to its tab", () => {
    expect(
      render([
        row("failures", "caution", {
          target: {
            kind: "section",
            tab: "failures",
            targetId: "audit-failures-heading",
          },
        }),
      ]),
    ).toContain('href="?tab=failures"');
  });

  test("links a chip that leaves the screen to its route", () => {
    expect(
      render([
        row("actionable", "caution", { target: { kind: "route", to: "/" } }),
      ]),
    ).toMatch(/<a [^>]*href="\/"/);
  });

  test("shows the label of the chip", () => {
    expect(render([row("holds", "normal")])).toContain("ラベル holds");
  });

  test("shows the conclusion of the chip", () => {
    expect(render([row("holds", "normal")])).toContain("結論 holds");
  });

  test("shows the count of failures in words, never hiding them", () => {
    expect(
      render([row("failures", "caution", { text: "監査2件、紐づかない5件" })]),
    ).toContain("監査2件、紐づかない5件");
  });

  test.each([
    ["normal", "正常"],
    ["caution", "注意"],
    ["action", "要対応"],
    ["none", "判定なし"],
  ] as const)(
    "names the level %s in words for screen readers",
    (level, label) => {
      expect(render([row("holds", level)])).toMatch(
        new RegExp(`<span[^>]*sr-only[^>]*>${label}</span>`),
      );
    },
  );

  test.each(["normal", "caution", "action", "none"] as const)(
    "draws a symbol for the level %s that screen readers skip",
    (level) => {
      expect(render([row("holds", level)])).toMatch(
        /<svg[^>]*aria-hidden="true"/,
      );
    },
  );

  test("colors the symbol of an action chip as a failure", () => {
    expect(render([row("holds", "action")])).toContain("text-failure");
  });

  test("colors the symbol of a caution chip as a warning", () => {
    expect(render([row("holds", "caution")])).toContain("text-warning");
  });

  test("colors the symbol of a normal chip as a success", () => {
    expect(render([row("holds", "normal")])).toContain("text-success");
  });

  test("links a chip to the notice in the inbox screen", () => {
    expect(
      render([
        row("deployment", "caution", {
          target: { kind: "route", to: "/?type=notice&id=7" },
        }),
      ]),
    ).toContain('href="/?type=notice&amp;id=7"');
  });

  test("puts the word of the level after the label and the conclusion", () => {
    const html = render([row("holds", "caution")]);
    const levelAt = html.search(/<span[^>]*sr-only[^>]*>注意<\/span>/);
    expect(levelAt).toBeGreaterThan(html.indexOf("結論 holds"));
  });

  test("shows the oldest time of fetch once, in the band", () => {
    expect(render([row("holds", "normal")], FETCHED_AT)).toContain(
      "最終取得 3分前",
    );
  });

  test("gives the time of fetch in Japan time for assistive technology", () => {
    expect(render([row("holds", "normal")], FETCHED_AT)).toContain(
      `(${formatAbsoluteIso(new Date(FETCHED_AT).toISOString())})`,
    );
  });

  test("shows no time of fetch before any fetch has returned", () => {
    expect(render([row("holds", "normal")], 0)).not.toContain("最終取得");
  });

  test("has no note, which belongs to the sections", () => {
    expect(render([row("holds", "normal")], FETCHED_AT)).not.toContain(
      "前回取得",
    );
  });

  test("has no list of other sections", () => {
    expect(render([row("holds", "normal")])).not.toContain("ほかの節");
  });

  test("tells that a value is the previous one when a refetch failed", () => {
    expect(render([row("holds", "caution", { stale: true })])).toContain(
      "前の値(取得に失敗)",
    );
  });

  test("does not say so for a fresh value", () => {
    expect(render([row("holds", "caution")])).not.toContain("前の値");
  });
});

describe("SummaryBand while a fetch is pending", () => {
  function pending(state: BandRowState): BandRow {
    return row("holds", "none", {
      state,
      text: state === "loading" ? "取得中です" : "取得できませんでした",
    });
  }

  test("keeps the loading words out of sight before the delay", () => {
    expect(render([pending("loading")])).not.toMatch(
      /<span(?![^>]*invisible)[^>]*>取得中です/,
    );
  });

  test("keeps the frame of the chip, so nothing moves when the value arrives", () => {
    expect(render([pending("loading")])).toContain("invisible");
  });

  test("hides the frame from screen readers", () => {
    expect(render([pending("loading")])).toMatch(
      /<span[^>]*aria-hidden="true"[^>]*>.*取得中です/,
    );
  });

  test("still shows the label of the chip", () => {
    expect(render([pending("loading")])).toContain("ラベル holds");
  });

  test("shows a failed fetch at once", () => {
    expect(render([pending("error")])).toContain("取得できませんでした");
  });

  test("does not hide a failed fetch", () => {
    expect(render([pending("error")])).not.toContain("invisible");
  });

  test("shows a value at once", () => {
    expect(render([row("holds", "normal")])).not.toContain("invisible");
  });
});
