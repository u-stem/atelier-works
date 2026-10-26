import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DeploymentEntry } from "../../api/guards/deployments.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import { UpdateHistory } from "./UpdateHistory.tsx";

const T0 = "2026-10-11T03:20:00.000Z";
const NOW = Date.parse("2026-10-11T04:00:00.000Z");
const REASON = "wmill sync push failed (exit 1, timed_out=false): boom";
const MARKUP_REASON = '<a href="https://evil.example">x</a><img src=x>';
const URL_REASON = "see https://evil.example/path for details";
const NO_REASON = "理由の記録はありません";

const FAILED: DeploymentEntry = {
  deployment_id: 1,
  sha_from: "a".repeat(40),
  sha_to: "b".repeat(40),
  result: "failed",
  needs_host_action: false,
  occurred_at: T0,
  pull_requests: [],
  error: REASON,
};

function render(entries: readonly DeploymentEntry[]): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <UpdateHistory entries={entries} now={NOW} />
    </TooltipProvider>,
  );
}

function renderReason(error: string | null): string {
  return render([{ ...FAILED, error }]);
}

describe("UpdateHistory", () => {
  test("shows the reason of a failed deployment", () => {
    expect(render([FAILED])).toContain(REASON);
  });

  test("labels the reason", () => {
    expect(render([FAILED])).toContain("理由: ");
  });

  test("shows only the head of a long reason", () => {
    expect(renderReason(`${"h".repeat(120)}TAIL`)).not.toContain("TAIL");
  });

  test("escapes markup in the reason", () => {
    expect(renderReason(MARKUP_REASON)).toContain(
      "&lt;a href=&quot;https://evil.example&quot;&gt;x&lt;/a&gt;&lt;img src=x&gt;",
    );
  });

  test("does not turn markup in the reason into a link", () => {
    expect(renderReason(MARKUP_REASON)).not.toContain("<a ");
  });

  test("does not turn markup in the reason into an image", () => {
    expect(renderReason(MARKUP_REASON)).not.toContain("<img");
  });

  test("does not turn a URL in the reason into a link", () => {
    expect(renderReason(URL_REASON)).not.toContain("<a ");
  });

  test("shows a URL in the reason as text", () => {
    expect(renderReason(URL_REASON)).toContain(URL_REASON);
  });

  test("states that a failure recorded without a reason has no reason", () => {
    expect(renderReason(null)).toContain(NO_REASON);
  });

  test("states that a failure from an older backend has no reason", () => {
    const { error: _omitted, ...older } = FAILED;
    expect(render([older])).toContain(NO_REASON);
  });

  test("shows no reason for a successful deployment", () => {
    const success = { ...FAILED, result: "success", error: null };
    expect(render([success])).not.toContain("理由");
  });
});

/** 理由の文字で見分けられる、`count`件の反映。 */
function manyEntries(count: number): DeploymentEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    ...FAILED,
    deployment_id: index + 1,
    error: `reason ${String(index + 1).padStart(3, "0")}`,
  }));
}

function renderPage(count: number, initialPage?: number): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <UpdateHistory
        entries={manyEntries(count)}
        now={NOW}
        initialPage={initialPage}
        initiallyExpanded
      />
    </TooltipProvider>,
  );
}

describe("UpdateHistory pagination", () => {
  test("shows the last item of the first page", () => {
    expect(renderPage(11)).toContain("reason 010");
  });

  test("leaves the item after the first page out of the first page", () => {
    expect(renderPage(11)).not.toContain("reason 011");
  });

  test("shows the item after the first page on the second page", () => {
    expect(renderPage(11, 1)).toContain("reason 011");
  });

  test("leaves the first page items out of the second page", () => {
    expect(renderPage(11, 1)).not.toContain("reason 010");
  });

  test("shows the last page for a page past the end", () => {
    expect(renderPage(11, 9)).toContain("reason 011");
  });

  test("shows the range of the page", () => {
    expect(renderPage(11, 1)).toContain("11–11件目 / 11件");
  });

  test("draws no page navigation for a single page", () => {
    expect(renderPage(10)).not.toContain("<nav");
  });

  test("keeps the empty message for no entries", () => {
    expect(renderPage(0)).toContain("反映の記録はまだありません");
  });
});

function renderFolded(entries: readonly DeploymentEntry[]): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <UpdateHistory entries={entries} now={NOW} />
    </TooltipProvider>,
  );
}

describe("UpdateHistory folded", () => {
  test("shows the newest three entries first", () => {
    expect(renderFolded(manyEntries(5))).toContain("reason 003");
  });

  test("leaves the fourth entry out until it is expanded", () => {
    expect(renderFolded(manyEntries(5))).not.toContain("reason 004");
  });

  test("offers to show all entries when there are more than three", () => {
    expect(renderFolded(manyEntries(4))).toContain("すべて表示");
  });

  test("tells how many entries there are on the button", () => {
    expect(renderFolded(manyEntries(12))).toContain("すべて表示(12件)");
  });

  test("offers nothing when the three entries are all there is", () => {
    expect(renderFolded(manyEntries(3))).not.toContain("すべて表示");
  });

  test("draws no page navigation while folded", () => {
    expect(renderFolded(manyEntries(30))).not.toContain("<nav");
  });

  test("keeps the button reachable by keyboard", () => {
    expect(renderFolded(manyEntries(5))).toMatch(/<button[^>]*>すべて表示/);
  });

  test("tells the button state to assistive technology", () => {
    expect(renderFolded(manyEntries(5))).toMatch(
      /<button[^>]*aria-expanded="false"[^>]*>すべて表示/,
    );
  });
});

describe("UpdateHistory host action beyond the first three", () => {
  function withHostActionAt(position: number): DeploymentEntry[] {
    return manyEntries(6).map((entry, index) => ({
      ...entry,
      needs_host_action: index === position,
    }));
  }

  test("tells how many entries outside the first three need host action", () => {
    expect(renderFolded(withHostActionAt(4))).toContain(
      "ホストの作業が要る反映: 1件",
    );
  });

  test("says nothing when the entry needing host action is among the first three", () => {
    expect(renderFolded(withHostActionAt(1))).not.toContain(
      "ホストの作業が要る反映",
    );
  });

  test("says nothing once everything is expanded", () => {
    expect(
      renderToStaticMarkup(
        <TooltipProvider>
          <UpdateHistory
            entries={withHostActionAt(4)}
            now={NOW}
            initiallyExpanded
          />
        </TooltipProvider>,
      ),
    ).not.toContain("ホストの作業が要る反映");
  });
});

describe("UpdateHistory pull request origin", () => {
  function withOrigin(origin: string): DeploymentEntry[] {
    return [
      {
        ...FAILED,
        pull_requests: [{ number: 7, title: "題名", origin, url: null }],
      },
    ];
  }

  test("shows the badge of a known origin", () => {
    expect(renderFolded(withOrigin("human"))).toContain("人");
  });

  test("shows no badge when the origin is unknown", () => {
    expect(renderFolded(withOrigin("unknown"))).not.toContain("不明");
  });

  test("still shows the title and the number when the origin is unknown", () => {
    expect(renderFolded(withOrigin("unknown"))).toContain("題名");
  });
});
