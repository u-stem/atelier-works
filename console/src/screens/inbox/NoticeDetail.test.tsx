import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { SummaryNotice } from "../../api/guards/summary.ts";
import {
  type ConfigSnapshotView,
  configQueryKey,
} from "../../api/jobsQueries.ts";
import { NoticeDetail } from "./NoticeDetail.tsx";

const NOW = Date.parse("2026-11-08T01:00:00.000Z");

const DOC =
  "https://github.com/octo-owner/atelier-works/blob/main/docs/operations.md";

/** `factory_repo`を持つ設定の取得の結果。 */
function configWith(factoryRepo: unknown): ConfigSnapshotView {
  return {
    path: "f/factory/factory_config",
    items: [
      { key: "factory_repo", kind: "value", value: factoryRepo, masked: false },
    ],
  };
}

const CONFIG = configWith("https://github.com/octo-owner/atelier-works");

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

/** 通知の詳細を描く。`config`を渡すと、設定の取得を済ませた状態で描く。 */
function render(
  notice: SummaryNotice,
  failureIds: ReadonlySet<number> = new Set(),
  config?: ConfigSnapshotView,
): string {
  const client = new QueryClient();
  if (config !== undefined) {
    client.setQueryData(configQueryKey, config);
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <NoticeDetail
          notice={notice}
          now={NOW}
          failureIds={failureIds}
          onOpenFailure={() => undefined}
        />
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

/** 運用の文書を指す`<a>`の開きタグ。無ければ空。URLは正規表現にせず、部分文字列で探す。 */
function procedureLinkTag(html: string): string {
  const at = html.indexOf(`href="${DOC}#`);
  if (at === -1) return "";
  const start = html.lastIndexOf("<a ", at);
  const end = html.indexOf(">", at);
  return start === -1 || end === -1 ? "" : html.slice(start, end + 1);
}

describe("NoticeDetail link to the procedure", () => {
  test("links the notice to the row of its kind in the operations document of factory_repo", () => {
    expect(
      render(
        noticeOf("cleanup_db_failed", { resolvable: true }),
        new Set(),
        CONFIG,
      ),
    ).toContain(`href="${DOC}#notice-cleanup_db_failed"`);
  });

  test("names the link after reading the procedure", () => {
    expect(
      render(
        noticeOf("cleanup_db_failed", { resolvable: true }),
        new Set(),
        CONFIG,
      ),
    ).toMatch(/<a [^>]*>運用の文書で手順を読む/);
  });

  test("opens the document in a new tab", () => {
    expect(
      procedureLinkTag(
        render(
          noticeOf("cleanup_db_failed", { resolvable: true }),
          new Set(),
          CONFIG,
        ),
      ),
    ).toContain('target="_blank"');
  });

  test("gives the document neither the opener nor the referrer", () => {
    expect(
      procedureLinkTag(
        render(
          noticeOf("cleanup_db_failed", { resolvable: true }),
          new Set(),
          CONFIG,
        ),
      ),
    ).toContain('rel="noopener noreferrer"');
  });

  test("links a kind that the Console does not know to the section of the kinds", () => {
    expect(render(noticeOf("future_kind"), new Set(), CONFIG)).toContain(
      `href="${DOC}#通知の種類"`,
    );
  });

  test("shows no link before the config is fetched", () => {
    expect(
      render(noticeOf("cleanup_db_failed", { resolvable: true })),
    ).not.toContain("docs/operations.md");
  });

  test("shows no link when factory_repo is not a GitHub repository URL", () => {
    expect(
      render(
        noticeOf("cleanup_db_failed", { resolvable: true }),
        new Set(),
        configWith("not a url"),
      ),
    ).not.toContain("docs/operations.md");
  });

  // 手順の文書は、通知の詳細の操作を読んだ後に開く補足なので、次の操作の欄の末尾に置く。
  test("puts the link after the commands of the action", () => {
    const html = render(noticeOf("host_action_required"), new Set(), CONFIG);

    expect(html.indexOf(`href="${DOC}#`)).toBeGreaterThan(
      html.lastIndexOf("<code"),
    );
  });
});

describe("NoticeDetail button to the failure of the named work item", () => {
  const MESSAGE = "o/r#2 (work item 42): 実装フローが止まりました。";
  const FAILURES = new Set([42]);

  // 移る先は同じ画面の別の項目なので、画面が履歴、チップ、フォーカスを決める。部品は遷移を自分で起こさない。
  test("offers a button for the failure of the work item the notice names", () => {
    expect(
      render(noticeOf("implement_needs_human", { message: MESSAGE }), FAILURES),
    ).toMatch(/<button [^>]*>作業項目 #42の失敗へ<\/button>/);
  });

  test("does not offer a link that would navigate without the screen", () => {
    expect(
      render(noticeOf("implement_needs_human", { message: MESSAGE }), FAILURES),
    ).not.toContain("failure=");
  });

  test("offers the button for a failed launch notice the same way", () => {
    expect(
      render(
        noticeOf("implement_launch_failed", { message: MESSAGE }),
        FAILURES,
      ),
    ).toContain("作業項目 #42の失敗へ");
  });

  test("shows no button when the failure is not in the list", () => {
    expect(
      render(
        noticeOf("implement_needs_human", { message: MESSAGE }),
        new Set([5]),
      ),
    ).not.toContain("の失敗へ");
  });

  test("shows no button when the list of failures is empty", () => {
    expect(
      render(noticeOf("implement_needs_human", { message: MESSAGE })),
    ).not.toContain("の失敗へ");
  });

  test("shows no button once the notice is resolved", () => {
    expect(
      render(
        noticeOf("implement_needs_human", { message: MESSAGE, resolved: true }),
        FAILURES,
      ),
    ).not.toContain("の失敗へ");
  });

  test("shows no button for a kind that does not name a work item to retry", () => {
    expect(
      render(
        noticeOf("approval_comment_failed", { message: MESSAGE }),
        FAILURES,
      ),
    ).not.toContain("の失敗へ");
  });

  test("shows no button when the message does not start with the work item", () => {
    expect(
      render(
        noticeOf("implement_needs_human", { message: `理由 ${MESSAGE}` }),
        FAILURES,
      ),
    ).not.toContain("の失敗へ");
  });

  test("puts the button after the text of the action", () => {
    const html = render(
      noticeOf("implement_needs_human", { message: MESSAGE }),
      FAILURES,
    );

    expect(html.indexOf("作業項目 #42の失敗へ")).toBeGreaterThan(
      html.indexOf("そこで再実行を押してください"),
    );
  });
});
