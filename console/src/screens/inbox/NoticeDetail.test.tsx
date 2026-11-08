import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { SummaryNotice } from "../../api/guards/summary.ts";
import { NoticeDetail } from "./NoticeDetail.tsx";

const NOW = Date.parse("2026-11-08T01:00:00.000Z");

function noticeOf(
  kind: string,
  overrides: Partial<SummaryNotice> = {},
): SummaryNotice {
  return {
    notice_id: 7,
    kind,
    message: "m",
    resolved: false,
    created_at: "2026-11-08T00:00:00.000Z",
    severity: "action",
    resolvable: false,
    ...overrides,
  };
}

function render(notice: SummaryNotice): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <NoticeDetail notice={notice} now={NOW} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("NoticeDetail move button", () => {
  test("links a deploy approval notice to its section of the system screen", () => {
    expect(render(noticeOf("deploy_approval_required"))).toMatch(
      /<a [^>]*href="\/system\?section=deploy-approvals"[^>]*>システムの画面の反映の承認待ちへ<\/a>/,
    );
  });

  test("links a held merge notice to the holds section", () => {
    expect(
      render(noticeOf("dependabot_merge_held", { severity: "info" })),
    ).toContain('href="/system?section=holds"');
  });

  test("links an active stop-all notice to the stop-all section", () => {
    expect(render(noticeOf("stop_all_active"))).toContain(
      'href="/system?section=stop-all"',
    );
  });

  test("shows no button for a kind without a target", () => {
    expect(
      render(noticeOf("cleanup_db_failed", { resolvable: true })),
    ).not.toContain("/system");
  });

  test("shows no button once the notice is resolved", () => {
    expect(
      render(noticeOf("deploy_approval_required", { resolved: true })),
    ).not.toContain("/system");
  });

  test("puts the button after the text of the action", () => {
    const html = render(
      noticeOf("dependabot_merge_held", { severity: "info" }),
    );

    expect(html.indexOf("/system?section=holds")).toBeGreaterThan(
      html.indexOf("システムの画面の「保留と凍結」で"),
    );
  });

  test("puts the button before the commands", () => {
    const html = render(
      noticeOf("dependabot_merge_held", { severity: "info" }),
    );

    const button = html.indexOf("/system?section=holds");

    expect(button >= 0 && button < html.indexOf("<code")).toBe(true);
  });
});
