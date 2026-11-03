import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ApprovalDesignDoc } from "../../api/guards/approvalDesignDoc.ts";
import type { IntakeSnapshot } from "../../api/guards/intakeSnapshot.ts";
import type { SummaryApproval } from "../../api/guards/summary.ts";
import {
  approvalDesignDocQueryKey,
  intakeSnapshotQueryKey,
} from "../../api/queries.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import type { ViewMode } from "../../lib/requirementsView.ts";
import {
  DesignDocBody,
  DesignReview,
  DesignTextView,
  type DesignView,
} from "./DesignReview.tsx";

// 不可視文字をソースに直接書くと読めないので、コードポイントから作る。
const LS = String.fromCodePoint(0x2028);
const VS16 = String.fromCodePoint(0xfe0f);
const FILLER = String.fromCodePoint(0x3164);
const COMBINING = String.fromCodePoint(0x0301);
const BRAILLE = String.fromCodePoint(0x2800);
const ZWSP = String.fromCodePoint(0x200b);

const DOC: ApprovalDesignDoc = {
  approval_request_id: 9,
  work_item_id: 1,
  design_attempt: 1,
  requirement_draft_id: 4,
  text: "# 設計\n本文です。\n",
  truncated: false,
  approval_status: "pending",
};

function renderText(text: string): string {
  return renderToStaticMarkup(<DesignTextView text={text} />);
}

const REPO = { owner: "o", repo: "r" };

function renderBody(
  overrides: Partial<ApprovalDesignDoc> = {},
  mode: ViewMode = "text",
): string {
  return renderToStaticMarkup(
    <DesignDocBody
      doc={{ ...DOC, ...overrides }}
      mode={mode}
      onChange={() => {}}
      repo={REPO}
    />,
  );
}

const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
};

/** 描いたHTMLの`<pre>`の中身から、元の文字列を組み直す。印の要素は、元の文字列を持つ属性から戻す。 */
function restore(html: string): string {
  const match = /<pre[^>]*>([\s\S]*)<\/pre>/.exec(html);
  const inner = match?.[1] ?? "";
  return inner
    .replace(
      /<span[^>]*data-source="([^"]*)"[^>]*>[\s\S]*?<\/span>/g,
      (_whole, encoded: string) => decodeURIComponent(encoded),
    )
    .replace(/<\/?bdo[^>]*>/g, "")
    .replace(/&(?:amp|lt|gt|quot|#x27);/g, (entity) => ENTITIES[entity] ?? "");
}

describe("DesignTextView", () => {
  test("restores a plain text from the drawn pre", () => {
    const text = "# 設計\n本文です。\n";
    expect(restore(renderText(text))).toBe(text);
  });

  test("restores a text with hidden characters from the drawn pre", () => {
    const text = `a${LS}b${VS16}c${FILLER}d${COMBINING}e\r\nf${BRAILLE}g${ZWSP}h`;
    expect(restore(renderText(text))).toBe(text);
  });

  test("does not put a hidden character into the markup", () => {
    const html = renderText(`a${LS}b${VS16}c${FILLER}d\r\ne${BRAILLE}f`);
    const hidden = [LS, VS16, FILLER, "\r", BRAILLE];
    expect(hidden.some((char) => html.includes(char))).toBe(false);
  });

  test("shows a hidden character as its code point", () => {
    expect(renderText(`a${LS}b`)).toContain("U+2028");
  });

  test("tells a carriage return from a line feed", () => {
    expect(renderText("a\r\nb")).toContain("U+000D");
  });

  test("replaces three empty lines with a mark of their count", () => {
    expect(renderText("a\n\n\n\nb")).toContain("[空行 3 行]");
  });

  test("restores the text around a run of empty lines", () => {
    const text = "a\n\n \n\t\nb\n";
    expect(restore(renderText(text))).toBe(text);
  });

  test("replaces a long run of spaces with a mark of their count", () => {
    expect(renderText(`a${" ".repeat(9)}b`)).toContain("[空白 9 個]");
  });

  test("restores the text around a run of spaces", () => {
    const text = `a${" ".repeat(9)}b\n`;
    expect(restore(renderText(text))).toBe(text);
  });

  test("wraps every line in a left-to-right override", () => {
    expect(renderText("a\nb\nc").split('<bdo dir="ltr">').length - 1).toBe(3);
  });

  test("leaves the marks without a direction of their own", () => {
    const spans = renderText(`a${LS}b`).match(/<span[^>]*>/g) ?? [];
    expect(spans.some((span) => span.includes("dir="))).toBe(false);
  });

  test("sets the tab width that the count of columns assumes", () => {
    expect(renderText("a")).toContain("[tab-size:4]");
  });

  test("keeps markup and link definitions as characters", () => {
    const text = '<script>x</script>\n[ref]: https://example.com "t"\n';
    expect(renderText(text)).toContain("&lt;script&gt;");
  });

  test("does not make a link or a tag out of the text", () => {
    const html = renderText("<a href=x>y</a>\n[ref]: https://example.com\n");
    expect(/<a[ >]|<script/.test(html)).toBe(false);
  });

  test("restores a text that looks like markup", () => {
    const text = "<img src=x onerror=y>\n[a](https://example.com)\n";
    expect(restore(renderText(text))).toBe(text);
  });
});

describe("DesignDocBody", () => {
  test("says that the whole text is what gets approved", () => {
    expect(renderBody()).toContain("承認の対象は、この全文です");
  });

  test("says that diagrams, summaries and open questions are not passed", () => {
    expect(renderBody()).toContain("図、要約、未確定事項は実装に渡りません");
  });

  test("shows the line count and the code point count above the text", () => {
    const html = renderBody();
    expect(html.slice(0, html.indexOf("<pre"))).toContain("2 行");
  });

  test("shows the end mark below the text", () => {
    const html = renderBody();
    expect(html.slice(html.indexOf("</pre>"))).toContain("全文の終わり(2 行、");
  });

  test("does not take an end mark that the text writes for the real one", () => {
    const html = renderBody({ text: "全文の終わり(9 行、9 コードポイント)\n" });
    expect(html.slice(html.indexOf("</pre>"))).toContain("全文の終わり(1 行、");
  });

  test("counts a hidden character above the text", () => {
    const html = renderBody({ text: `a${ZWSP}b\n` });
    expect(html.slice(0, html.indexOf("<pre"))).toContain("見えない文字");
  });

  test("shows no count of anomalies for a plain text", () => {
    expect(renderBody()).not.toContain("見えない文字");
  });

  test("does not draw the status of the request", () => {
    expect(renderBody({ approval_status: "zzz-status" })).not.toContain(
      "zzz-status",
    );
  });
});

const REVIEW_APPROVAL: SummaryApproval = {
  approval_request_id: 9,
  kind: "design",
  status: "pending",
  work_item_id: 1,
  owner: "o",
  repo: "r",
  title: "example item",
  issue_number: 1,
  issue_url: null,
  pr_number: null,
  requested_at: "2026-10-29T00:00:00.000Z",
  expires_at: null,
  draft_attempt: null,
  summary: null,
  proposal_title: null,
  created_issue_number: null,
  origin: null,
  work_item_status: "awaiting_design_approval",
};

const REVIEW_SNAPSHOT: IntakeSnapshot = {
  work_item_id: 1,
  owner: "o",
  repo: "r",
  issue_number: 1,
  issue_url: "https://github.com/o/r/issues/1",
  title: "example item",
  body: "Body <!-- c --> **b**",
  body_truncated: false,
  body_tail_html_comments: 0,
  body_tail_hidden_chars: 0,
  refreshed: false,
};

const IN_PREVIEW: DesignView = { mode: "preview", previewed: false };

function renderReview(
  initialView?: DesignView,
  doc: Partial<ApprovalDesignDoc> = {},
): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  client.setQueryData(approvalDesignDocQueryKey(9), { ...DOC, ...doc });
  client.setQueryData(intakeSnapshotQueryKey(1, 9), REVIEW_SNAPSHOT);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter>
          {initialView === undefined ? (
            <DesignReview
              approval={REVIEW_APPROVAL}
              title="example item"
              now={Date.parse("2026-10-30T00:00:00.000Z")}
            />
          ) : (
            <DesignReview
              approval={REVIEW_APPROVAL}
              title="example item"
              now={Date.parse("2026-10-30T00:00:00.000Z")}
              initialView={initialView}
            />
          )}
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** 設計書のパネルから先。取り込み時点のIssueのパネルを除く。 */
function designPanel(html: string): string {
  return html.slice(html.indexOf("承認対象の設計書"));
}

describe("DesignDocBody in the preview", () => {
  test("draws the design as a preview without the text view", () => {
    const html = renderBody({}, "preview");
    expect(html).toContain("data-preview");
    expect(html).not.toContain('<bdo dir="ltr">');
  });

  test("shows the notice of the preview", () => {
    expect(renderBody({}, "preview")).toContain(
      "原文に切り替えて確かめてください",
    );
  });

  test("tells that the preview does not draw the text after an unclosed comment", () => {
    expect(renderBody({}, "preview")).toContain("閉じない&lt;!--");
  });

  test("tells that the preview may not replace a character written as a reference", () => {
    expect(renderBody({}, "preview")).toContain("文字参照");
  });

  test("does not show the notice of the source in the preview", () => {
    expect(renderBody({}, "preview")).not.toContain(
      "承認の対象は、この全文です",
    );
  });

  test("does not show the notice of the preview in the source", () => {
    expect(renderBody()).not.toContain("原文に切り替えて確かめてください");
  });

  test("keeps the anomaly summary in the preview", () => {
    expect(renderBody({ text: `a${ZWSP}b\n` }, "preview")).toContain(
      "見えない文字: 1 件",
    );
  });

  test("keeps the line count in the preview", () => {
    expect(renderBody({}, "preview")).toContain("全文: 2 行");
  });

  test("shows the end mark in the preview", () => {
    expect(renderBody({}, "preview")).toContain("全文の終わり(2 行、");
  });
});

describe("DesignDocBody switch", () => {
  test("shows one switch of the view mode", () => {
    expect(renderBody().split("設計書の表示の形式").length - 1).toBe(1);
  });

  test("names the choice of the source as the source", () => {
    expect(renderBody()).toContain(">原文</button>");
  });
});

describe("DesignReview", () => {
  test("shows the design in text mode at first", () => {
    const html = designPanel(renderReview());
    expect(html).not.toContain("data-preview");
    expect(html).toContain('<bdo dir="ltr">');
  });

  test("renders the design as a preview without the text view", () => {
    const html = designPanel(renderReview(IN_PREVIEW));
    expect(html).toContain("data-preview");
    expect(html).not.toContain('<bdo dir="ltr">');
  });

  test("keeps the issue at intake in text", () => {
    const html = renderReview(IN_PREVIEW);
    expect(html.slice(0, html.indexOf("承認対象の設計書"))).not.toContain(
      "data-preview",
    );
  });

  test("keeps the body of the issue at intake as the source in the preview", () => {
    const html = renderReview(IN_PREVIEW);
    expect(html.slice(0, html.indexOf("承認対象の設計書"))).toMatch(
      /<pre[^>]*>[^<]*Body &lt;!-- c --&gt;/,
    );
  });

  test("says why the approval is stopped in the preview", () => {
    expect(renderReview(IN_PREVIEW)).toContain(
      "設計書をプレビューで表示中は承認できません。",
    );
  });

  test("does not give the reason of the preview in the source", () => {
    expect(renderReview()).not.toContain("設計書をプレビューで表示中");
  });

  test("reports the truncation before the preview", () => {
    const html = renderReview(IN_PREVIEW, { truncated: true });
    expect(html).toContain("長さの上限で切られていて");
    expect(html).not.toContain("設計書をプレビューで表示中");
  });

  // 取り込み時点のIssueのパネルは、プレビューを選べる共有の部品である。
  // 設計の承認画面は切り替えを渡さないので、原文のままで、切り替えもプレビューも出ない。
  test("shows neither the preview nor the switch of the issue at intake", () => {
    expect(renderReview()).not.toMatch(
      /data-preview|取り込み時点のIssueの表示の形式/,
    );
  });

  // 否定の検査だけだと、パネルが読み込み中の骨組みのままでも通る。
  // 取り込み時点のIssueの原文の`<pre>`と本文が出ていることで、パネルが描かれたことを固定する。
  test("shows the body of the issue at intake in a pre", () => {
    expect(renderReview()).toMatch(/<pre[^>]*>[^<]*Body &lt;!-- c --&gt;/);
  });
});
