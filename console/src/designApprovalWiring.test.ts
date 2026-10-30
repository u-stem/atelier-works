// 設計の承認画面の配線を確かめる契約テスト。
// 承認の画面(`ApprovalOverview`)に設計の依頼を渡して描き、全文に見えない文字や見えにくい並びがあるとき、
// 承認のボタンが押せず、止める理由が出ることを、画面を通して確かめる。
// 止める判定の本体は`visibleText.ts`にあるが、画面がそれを通さなければ判定は効かない。
// そのため、判定の関数だけでなく、画面から承認のボタンまでの配線をここで固定する。
// このテストは保護パスにある。配線を外す変更は、人のレビューを経る。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ApprovalDesignDoc } from "./api/guards/approvalDesignDoc.ts";
import type { IntakeSnapshot } from "./api/guards/intakeSnapshot.ts";
import type { SummaryApproval } from "./api/guards/summary.ts";
import {
  approvalDesignDocQueryKey,
  intakeSnapshotQueryKey,
} from "./api/queries.ts";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { ApprovalOverview } from "./screens/inbox/ApprovalOverview.tsx";

// 不可視文字をソースに直接書くと読めないので、コードポイントから作る。
const ZWSP = String.fromCodePoint(0x200b);
const HEBREW_ALEF = String.fromCodePoint(0x05d0);
const FILLER = String.fromCodePoint(0x3164);

const NOW = Date.parse("2026-10-30T00:00:00.000Z");
const REQUEST_ID = 9;
const WORK_ITEM_ID = 1;

const APPROVAL: SummaryApproval = {
  approval_request_id: REQUEST_ID,
  kind: "design",
  status: "pending",
  work_item_id: WORK_ITEM_ID,
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

const DOC: ApprovalDesignDoc = {
  approval_request_id: REQUEST_ID,
  work_item_id: WORK_ITEM_ID,
  design_attempt: 1,
  requirement_draft_id: 4,
  text: "# 設計\n本文です。\n",
  truncated: false,
  approval_status: "pending",
};

const SNAPSHOT: IntakeSnapshot = {
  work_item_id: WORK_ITEM_ID,
  owner: "o",
  repo: "r",
  issue_number: 1,
  issue_url: "https://github.com/o/r/issues/1",
  title: "example item",
  body: "body",
  body_truncated: false,
  body_tail_html_comments: 0,
  body_tail_hidden_chars: 0,
  refreshed: false,
};

type Seed = {
  readonly approval?: Partial<SummaryApproval>;
  readonly doc?: Partial<ApprovalDesignDoc> | null;
  readonly snapshot?: Partial<IntakeSnapshot> | null;
};

/** 設計の依頼を描く。取得の結果は、あらかじめキャッシュに入れる。 */
function render(seed: Seed = {}): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  client.setQueryData(
    approvalDesignDocQueryKey(REQUEST_ID),
    seed.doc === null ? null : { ...DOC, ...seed.doc },
  );
  client.setQueryData(
    intakeSnapshotQueryKey(WORK_ITEM_ID, REQUEST_ID),
    seed.snapshot === null ? null : { ...SNAPSHOT, ...seed.snapshot },
  );
  // このファイルは`.ts`なので、JSXを使わずに要素を組む。
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        TooltipProvider,
        null,
        createElement(
          MemoryRouter,
          null,
          createElement(ApprovalOverview, {
            approval: { ...APPROVAL, ...seed.approval },
            now: NOW,
          }),
        ),
      ),
    ),
  );
}

/** 承認のボタンのタグ。 */
function approveButton(html: string): string {
  return /<button[^>]*>承認する<\/button>/.exec(html)?.[0] ?? "";
}

function approveIsDisabled(html: string): boolean {
  return approveButton(html).includes("disabled");
}

describe("the approval screen of a design", () => {
  test("lets a plain design be approved", () => {
    const html = render();
    expect(approveButton(html)).not.toBe("");
    expect(approveIsDisabled(html)).toBe(false);
  });

  test("draws the whole text that the implementation receives", () => {
    expect(render()).toContain("本文です。");
  });

  test.each([
    ["a zero width space", `a${ZWSP}b\n`],
    ["a run of lines with only spaces", `a\n${" \n".repeat(400)}b\n`],
    ["a strong right to left character", `a${HEBREW_ALEF}b\n`],
    ["a text that imitates the mark of empty lines", "a\n[空行 5 行]\nb\n"],
    ["a hangul filler", `a${FILLER}b\n`],
  ])("stops the approval of %s", (_name, text) => {
    expect(approveIsDisabled(render({ doc: { text } }))).toBe(true);
  });

  test("says why the approval is stopped by an anomaly", () => {
    expect(render({ doc: { text: `a${ZWSP}b\n` } })).toContain(
      "却下を勧めます",
    );
  });

  test("stops the approval of a text cut at the limit", () => {
    expect(approveIsDisabled(render({ doc: { truncated: true } }))).toBe(true);
  });

  test("stops the approval while the design is not awaiting its approval", () => {
    expect(
      approveIsDisabled(
        render({ approval: { work_item_status: "implementing" } }),
      ),
    ).toBe(true);
  });

  test("stops the approval when the work item status is missing", () => {
    expect(
      approveIsDisabled(render({ approval: { work_item_status: undefined } })),
    ).toBe(true);
  });

  test("stops the approval when no design is found for the request", () => {
    expect(approveIsDisabled(render({ doc: null }))).toBe(true);
  });

  test("stops the approval of a design that belongs to another request", () => {
    expect(
      approveIsDisabled(render({ doc: { approval_request_id: 10 } })),
    ).toBe(true);
  });

  test("stops the approval when the issue at intake cannot be seen", () => {
    expect(approveIsDisabled(render({ snapshot: null }))).toBe(true);
  });

  test("keeps the rejection out of the stop by an anomaly", () => {
    const html = render({ doc: { text: `a${ZWSP}b\n` } });
    const reject = /<button[^>]*>却下する<\/button>/.exec(html)?.[0] ?? "";
    // 理由が空なので、却下のボタンは理由の欠落で止まる。止める理由は承認だけの文である。
    expect(reject).not.toBe("");
    expect(html).toContain("却下の理由");
  });
});

function source(path: string): string {
  return readFileSync(resolve(import.meta.dir, "../..", path), "utf8");
}

describe("the source of the wiring", () => {
  const overview = source("console/src/screens/inbox/ApprovalOverview.tsx");
  const review = source("console/src/screens/inbox/DesignReview.tsx");
  const bar = source("console/src/screens/inbox/ApprovalBar.tsx");

  test("the overview hands a design to the design screen", () => {
    expect(overview).toMatch(/approval\.kind === "design"[\s\S]*<DesignReview/);
  });

  test("the design screen decides the stop through designBlockedReason", () => {
    expect(review).toContain("designBlockedReason(");
  });

  test("the design screen gives the decision to the approval bar as the reason to stop", () => {
    expect(review).toMatch(/approveBlockedReason=\{/);
  });

  test("the approval bar uses the reason to stop only for the approval", () => {
    const uses = bar.match(/approveBlockedReason/g) ?? [];
    // 型の宣言、引数の受け取り、承認の判定への受け渡しの3か所だけ。却下の判定は使わない。
    expect(uses.length).toBe(3);
  });

  test("the approval bar judges the rejection without the reason to stop", () => {
    expect(bar).toMatch(/rejectProblem\(reason\)/);
  });
});
