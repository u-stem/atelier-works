import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { NoticeRow } from "../../api/guards/notices.ts";
import type { SystemResolvedNotice } from "../../api/guards/systemStatus.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import {
  InfoNoticeDisclosure,
  InfoNoticeList,
  ResolvedNoticeDisclosure,
  ResolvedNoticeList,
} from "./NoticeLists.tsx";

const NOW = Date.parse("2026-10-11T04:00:00.000Z");
const CREATED = "2026-10-11T03:00:00.000Z";

/** 本文の文字で見分けられる、`count`件の情報の通知。 */
function infoNotices(count: number): NoticeRow[] {
  return Array.from({ length: count }, (_, index) => ({
    notice_id: index + 1,
    kind: "info_kind",
    message: `info ${String(index + 1).padStart(3, "0")}`,
    resolved: false,
    created_at: CREATED,
    severity: "info",
    resolvable: false,
  }));
}

/** 本文の文字で見分けられる、`count`件の解決済みの通知。 */
function resolvedNotices(count: number): SystemResolvedNotice[] {
  return Array.from({ length: count }, (_, index) => ({
    notice_id: index + 1,
    kind: "info_kind",
    message: `resolved ${String(index + 1).padStart(3, "0")}`,
    created_at: CREATED,
    resolved_by: "cleanup_db",
    resolved_at: CREATED,
  }));
}

function renderInfo(count: number, initialPage?: number): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>
        <InfoNoticeList
          notices={infoNotices(count)}
          now={NOW}
          initialPage={initialPage}
        />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

function renderResolved(count: number, initialPage?: number): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>
        <ResolvedNoticeList
          notices={resolvedNotices(count)}
          now={NOW}
          initialPage={initialPage}
        />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe("InfoNoticeList pagination", () => {
  test("shows the last item of the first page", () => {
    expect(renderInfo(11)).toContain("info 010");
  });

  test("leaves the item after the first page out of the first page", () => {
    expect(renderInfo(11)).not.toContain("info 011");
  });

  test("shows the item after the first page on the second page", () => {
    expect(renderInfo(11, 1)).toContain("info 011");
  });

  test("leaves the first page items out of the second page", () => {
    expect(renderInfo(11, 1)).not.toContain("info 010");
  });

  test("shows the last page for a page past the end", () => {
    expect(renderInfo(11, 9)).toContain("info 011");
  });

  test("draws no page navigation for a single page", () => {
    expect(renderInfo(10)).not.toContain("<nav");
  });

  test("keeps the empty message for no notices", () => {
    expect(renderInfo(0)).toContain("情報の通知はありません");
  });
});

describe("ResolvedNoticeList pagination", () => {
  test("shows the last item of the first page", () => {
    expect(renderResolved(11)).toContain("resolved 010");
  });

  test("leaves the item after the first page out of the first page", () => {
    expect(renderResolved(11)).not.toContain("resolved 011");
  });

  test("shows the item after the first page on the second page", () => {
    expect(renderResolved(11, 1)).toContain("resolved 011");
  });

  test("leaves the first page items out of the second page", () => {
    expect(renderResolved(11, 1)).not.toContain("resolved 010");
  });

  test("shows the last page for a page past the end", () => {
    expect(renderResolved(11, 9)).toContain("resolved 011");
  });

  test("draws no page navigation for a single page", () => {
    expect(renderResolved(10)).not.toContain("<nav");
  });

  test("keeps the empty message for no notices", () => {
    expect(renderResolved(0)).toContain("解決済みの通知はありません");
  });
});

function renderDisclosure(count: number, initiallyOpen?: boolean): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>
        <ResolvedNoticeDisclosure
          notices={resolvedNotices(count)}
          now={NOW}
          initiallyOpen={initiallyOpen}
        />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe("ResolvedNoticeDisclosure", () => {
  test("folds the history by default", () => {
    expect(renderDisclosure(3)).toMatch(/^<details/);
  });

  test("starts closed", () => {
    expect(renderDisclosure(3)).not.toMatch(/^<details[^>]* open/);
  });

  test("shows the count in the summary line", () => {
    expect(renderDisclosure(30)).toMatch(/<summary[^>]*>.*30件/);
  });

  test("shows the count of an empty history", () => {
    expect(renderDisclosure(0)).toMatch(/<summary[^>]*>.*0件/);
  });

  test("stays closed on a jump, since no chip leads here", () => {
    expect(renderDisclosure(3)).not.toContain("data-jump-open");
  });

  test("can start open", () => {
    expect(renderDisclosure(3, true)).toMatch(/^<details[^>]* open/);
  });

  test("keeps the list inside", () => {
    expect(renderDisclosure(3)).toContain("resolved 001");
  });
});

function renderInfoDisclosure(count: number, initiallyOpen?: boolean): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>
        <InfoNoticeDisclosure
          notices={infoNotices(count)}
          now={NOW}
          initiallyOpen={initiallyOpen}
        />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe("InfoNoticeDisclosure", () => {
  test("folds the notices, which need no action", () => {
    expect(renderInfoDisclosure(3)).toMatch(/^<details/);
  });

  test("starts closed", () => {
    expect(renderInfoDisclosure(3)).not.toMatch(/^<details[^>]* open/);
  });

  test("shows the count in the summary line", () => {
    expect(renderInfoDisclosure(6)).toMatch(/<summary[^>]*>.*6件/);
  });

  test("stays closed on a jump, since no chip leads here", () => {
    expect(renderInfoDisclosure(3)).not.toContain("data-jump-open");
  });

  test("can start open", () => {
    expect(renderInfoDisclosure(3, true)).toMatch(/^<details[^>]* open/);
  });

  test("keeps the list and its pagination inside", () => {
    expect(renderInfoDisclosure(11)).toContain("<nav");
  });

  test("draws no fold when there is no notice", () => {
    expect(renderInfoDisclosure(0)).not.toContain("<details");
  });

  test("keeps the empty message when there is no notice", () => {
    expect(renderInfoDisclosure(0)).toContain("情報の通知はありません");
  });
});
