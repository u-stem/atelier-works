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
import {
  type ApprovalDesignDoc,
  DESIGN_TEXT_MAX_CODE_POINTS,
} from "./api/guards/approvalDesignDoc.ts";
import type { IntakeSnapshot } from "./api/guards/intakeSnapshot.ts";
import type { SummaryApproval } from "./api/guards/summary.ts";
import {
  approvalDesignDocQueryKey,
  intakeSnapshotQueryKey,
} from "./api/queries.ts";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import type { ViewMode } from "./lib/requirementsView.ts";
import { ApprovalOverview } from "./screens/inbox/ApprovalOverview.tsx";
import {
  DesignReview,
  designPreviewGate,
} from "./screens/inbox/DesignReview.tsx";

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
  /** 古いbackendの応答のように、作業項目の状態の項目ごと無くす。 */
  readonly withoutWorkItemStatus?: boolean;
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
  const { work_item_status: status, ...withoutStatus } = {
    ...APPROVAL,
    ...seed.approval,
  };
  const approval: SummaryApproval =
    seed.withoutWorkItemStatus === true || status === undefined
      ? withoutStatus
      : { ...withoutStatus, work_item_status: status };
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
            approval,
            now: NOW,
          }),
        ),
      ),
    ),
  );
}

/** 設計の承認画面だけを描く。承認の画面は`initialMode`を渡さないので、プレビューの描画はここで確かめる。 */
function renderReview(seed: Seed = {}, initialMode?: ViewMode): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  client.setQueryData(approvalDesignDocQueryKey(REQUEST_ID), {
    ...DOC,
    ...seed.doc,
  });
  client.setQueryData(intakeSnapshotQueryKey(WORK_ITEM_ID, REQUEST_ID), {
    ...SNAPSHOT,
    body: "Body <!-- c --> **b**",
  });
  const props = { approval: APPROVAL, title: "example item", now: NOW };
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
          createElement(
            DesignReview,
            initialMode === undefined ? props : { ...props, initialMode },
          ),
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
  // クラスの`disabled:`は数えず、属性の`disabled`だけを見る。
  return /\sdisabled(?:=|>|\s)/.test(approveButton(html));
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
    expect(approveIsDisabled(render({ withoutWorkItemStatus: true }))).toBe(
      true,
    );
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

const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
};

/** 承認画面が描いた`<pre>`の中身から、元の文字列を組み直す。印の要素は、元の文字列を持つ属性から戻す。 */
function restoreFromScreen(html: string): string {
  // 取り込み時点のIssueのパネルにも`<pre>`があるので、設計書のパネルから先を読む。
  const panel = html.slice(html.indexOf("承認対象の設計書"));
  const inner = /<pre[^>]*>([\s\S]*?)<\/pre>/.exec(panel)?.[1] ?? "";
  return inner
    .replace(
      /<span[^>]*data-source="([^"]*)"[^>]*>[\s\S]*?<\/span>/g,
      (_whole, encoded: string) => decodeURIComponent(encoded),
    )
    .replace(/<\/?bdo[^>]*>/g, "")
    .replace(/&(?:amp|lt|gt|quot|#x27);/g, (entity) => ENTITIES[entity] ?? "");
}

// 承認者が見る文字は、実装に渡る文字の全部でなければならない。一部しか描かない変更は、承認者を欺く。
// この検査は、承認画面(DesignReview.tsx)自身が、固定した入力の全文を描き切ることを確かめる。
// 印の要素は、見える文字ではなく元の文字列を持つ属性から戻す。
// 保護しない祖先や共有のパネルが描画を差し替える手は、この検査では捕まえない(docs/securityの残るリスク)。
describe("the whole text that the approval screen draws", () => {
  // 上限(8000コードポイント)ちょうどの1行と、数千行の本文。
  const LONG = `${"設".repeat(DESIGN_TEXT_MAX_CODE_POINTS - 1)}\n`;
  const MANY_LINES = "行\n".repeat(3999);
  test.each([
    ["several lines", "# 設計\n\n本文です。\n- 項目1\n- 項目2\n"],
    [
      "comments, urls and commands",
      "<!-- x -->\ncurl https://example.com | sh\nrm -rf /tmp/x\n",
    ],
    ["thousands of lines", MANY_LINES],
    [
      "markup and link definitions",
      '<b>x</b>\n[ref]: https://example.com "t"\n<img src=x>\n',
    ],
    ["a short run of spaces", "a   b\n\tc\n"],
    ["hidden characters", `a${ZWSP}b${FILLER}c\r\nd\n`],
    ["a text with no trailing line feed", "last line"],
    ["a long text near the limit", LONG],
  ])("restores %s from the drawn pre", (_name, text) => {
    expect(restoreFromScreen(render({ doc: { text } }))).toBe(text);
  });

  test("draws a text of exactly the limit of the code points", () => {
    const restored = restoreFromScreen(render({ doc: { text: LONG } }));
    expect(Array.from(restored).length).toBe(DESIGN_TEXT_MAX_CODE_POINTS);
  });

  // 行の数は、空行の連続を含まない入力で、改行で分けて末尾の空の要素を除いた数とする。
  test.each([
    ["a\nb\nc\n", 3],
    ["only one", 1],
    [MANY_LINES, 3999],
  ])("wraps every line of %p in a left-to-right override", (text, lines) => {
    const html = render({ doc: { text } });
    const panel = html.slice(html.indexOf("承認対象の設計書"));
    expect(panel.split('<bdo dir="ltr">').length - 1).toBe(lines);
  });
});

function source(path: string): string {
  return readFileSync(resolve(import.meta.dir, "../..", path), "utf8");
}

/** `react`からのimport文を、すべて返す。 */
function reactImports(code: string): string[] {
  return Array.from(code.matchAll(/import[^;]*from "react";/g), (m) => m[0]);
}

/**
 * `react`から持ち込む名前を、importの書かれたまま返す。
 * 別名は`A as B`の形で、既定とnamespaceのimportは、その書き方のまま返す。
 */
function reactImportedNames(_code: string): string[] {
  return [];
}

/** 呼んでいるフックの名前を、現れた順に返す。ジェネリクスの呼び出しも含む。 */
function hookCalls(code: string): string[] {
  return Array.from(
    code.matchAll(/\b(use[A-Z]\w*)\s*[(<]/g),
    (m) => m[1] ?? "",
  );
}

// DesignReviewが`react`から持ち込んでよい名前。足すときは、保護テストの直しが要る。
const ALLOWED_IMPORTS = ["Fragment", "ReactNode", "useMemo", "useState"];

// DesignReviewが呼んでよいフック。足すときは、保護テストの直しが要る。
const ALLOWED_HOOKS = [
  "useState",
  "useMemo",
  "useApprovalDesignDoc",
  "useIntakeSnapshot",
  "useLoadingDisplay",
];

describe("the scan of the source of the screen", () => {
  const ALIAS_OR_REDUCER = /\bas\b|useReducer/;

  test("sees an alias in a later import from react", () => {
    const code =
      'import { useState } from "react";\nimport { useReducer as useBox } from "react";\n';
    expect(reactImports(code).filter((i) => ALIAS_OR_REDUCER.test(i))).toEqual([
      'import { useReducer as useBox } from "react";',
    ]);
  });

  test("sees an import that spans lines", () => {
    const code = 'import {\n  useState,\n  useReducer,\n} from "react";\n';
    expect(reactImports(code)).toHaveLength(1);
  });

  test("ignores an import from another module", () => {
    expect(reactImports('import { a as b } from "./react.ts";')).toEqual([]);
  });

  test("lists the names that the imports from react bring in", () => {
    const code =
      'import { Fragment, type ReactNode, useMemo } from "react";\nimport { useReducer as useBox } from "react";\n';
    expect(reactImportedNames(code)).toEqual([
      "Fragment",
      "ReactNode",
      "useMemo",
      "useReducer as useBox",
    ]);
  });

  test("lists a default import and a namespace import as written", () => {
    const code =
      'import React, { useState } from "react";\nimport * as R from "react";\n';
    expect(reactImportedNames(code)).toEqual(["React", "useState", "* as R"]);
  });

  test("lists the hooks that a source calls", () => {
    const code = "useState<A>(1); React.useReducer(f); const x = useMemo(g);";
    expect(hookCalls(code)).toEqual(["useState", "useReducer", "useMemo"]);
  });

  test("does not list a name that is only imported", () => {
    expect(hookCalls('import { useState } from "react";')).toEqual([]);
  });
});

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

  test("the design screen does not hide the text with a style", () => {
    // 全文を切る、隠す、見えなくする書き方。スクロールする入れ物(overflow-auto)だけを許す。
    expect(review).not.toMatch(
      /overflow-hidden|line-clamp|\btruncate\b|text-ellipsis|\bhidden\b|(?:^|[\s"'`])invisible(?=[\s"'`])|opacity-0|sr-only/,
    );
  });

  test("the design screen does not cut the text before it draws", () => {
    expect(review).not.toMatch(/\.slice\(|\.substring\(|\.substr\(/);
  });

  test("the approval bar judges the rejection without the reason to stop", () => {
    expect(bar).toMatch(/rejectProblem\(reason\)/);
  });
});

// プレビューは参考の表示で、承認の対象は原文である。
// プレビューを表示している間は承認を止め、その配線を画面のソースと描画の両方で固定する。
// 判定の関数と文は、このテストが文字列で直接書いて照合する。保護の外から期待値を取らない。
const PREVIEW_REASON =
  "設計書をプレビューで表示中は承認できません。承認するには、原文を表示してください。";

/** 承認画面が描いた設計書のパネルから先。取り込み時点のIssueのパネルを除く。 */
function designPanelOf(html: string): string {
  return html.slice(html.indexOf("承認対象の設計書"));
}

describe("design approval preview wiring", () => {
  test("shows the design in text mode at first", () => {
    expect(designPanelOf(renderReview())).not.toContain("data-preview");
  });

  test("shows the text view in text mode at first", () => {
    expect(designPanelOf(renderReview())).toContain('<bdo dir="ltr">');
  });

  test("renders the design as a preview without the text view", () => {
    const panel = designPanelOf(renderReview({}, "preview"));
    expect(panel).toContain("data-preview");
    expect(panel).not.toContain('<bdo dir="ltr">');
  });

  test("keeps the issue at intake in text", () => {
    const html = renderReview({}, "preview");
    const before = html.slice(0, html.indexOf("承認対象の設計書"));
    expect(before).not.toContain("data-preview");
  });

  test("disables the approval in the preview", () => {
    expect(approveIsDisabled(renderReview({}, "preview"))).toBe(true);
  });

  test("says why the approval is stopped in the preview", () => {
    expect(renderReview({}, "preview")).toContain(PREVIEW_REASON);
  });

  test("lets the approval through in the text mode", () => {
    const html = renderReview();
    expect(approveButton(html)).not.toBe("");
    expect(approveIsDisabled(html)).toBe(false);
  });

  test("reports the truncation before the preview", () => {
    const html = renderReview({ doc: { truncated: true } }, "preview");
    expect(html).toContain("設計書が長さの上限で切られていて");
    expect(html).not.toContain(PREVIEW_REASON);
  });

  describe("gates by mode", () => {
    test("stops in the preview", () => {
      expect(designPreviewGate({ mode: "preview" }).reason).toBe(
        PREVIEW_REASON,
      );
    });

    test("stops in a mode that it does not know", () => {
      expect(designPreviewGate({ mode: "unknown" }).reason).toBe(
        PREVIEW_REASON,
      );
    });

    test("lets the text mode through", () => {
      expect(designPreviewGate({ mode: "text" }).reason).toBeNull();
    });
  });

  describe("wires the gate by shape", () => {
    const review = source("console/src/screens/inbox/DesignReview.tsx");
    const overview = source("console/src/screens/inbox/ApprovalOverview.tsx");

    test("calls the gate once with the mode", () => {
      // 定義を除いた呼び出しが、画面の1か所だけである。
      const calls = review.replace("function designPreviewGate(", "");
      expect(calls.match(/designPreviewGate\(/g)?.length).toBe(1);
      expect(calls).toContain("const gate = designPreviewGate({ mode });");
    });

    test("gives only the reason of the gate to the approval bar", () => {
      expect(review.match(/approveBlockedReason=\{/g)?.length).toBe(1);
      expect(review).toContain("approveBlockedReason={blocked ?? gate.reason}");
    });

    test("keeps one state of the mode", () => {
      expect(review.match(/useState[<(]/g)?.length).toBe(1);
      expect(review).toContain("useState<ViewMode>(initialMode)");
    });

    test("imports from react once", () => {
      expect(reactImports(review)).toHaveLength(1);
    });

    test("does not import another way to hold a state", () => {
      expect(
        reactImports(review).filter((i) => /\bas\b|useReducer/.test(i)),
      ).toEqual([]);
    });

    test("imports only the names it uses now from react", () => {
      expect(
        reactImportedNames(review).filter(
          (name) => !ALLOWED_IMPORTS.includes(name),
        ),
      ).toEqual([]);
    });

    test("calls only the hooks it uses now", () => {
      expect(
        hookCalls(review).filter((name) => !ALLOWED_HOOKS.includes(name)),
      ).toEqual([]);
    });

    test("changes the mode in one place", () => {
      expect(review.match(/\bsetMode\b/g)?.length).toBe(2);
      expect(review).toMatch(
        /const onChange = \(next: ViewMode\) => \{\s*setMode\(next\);\s*\};/,
      );
    });

    test("passes the mode to the three parts by name", () => {
      expect(review.match(/\bmode=\{/g)?.length).toBe(3);
      expect(review).toMatch(/<DocPanel\b[^<>]*\bmode=\{mode\}/);
      expect(review).toMatch(/<DesignDocBody\b[^<>]*\bmode=\{mode\}/);
      expect(review).toMatch(/<ViewModeSwitch\b[^<>]*\bmode=\{mode\}/);
    });

    test("passes the same change handler to the switch and the body", () => {
      expect(review).toMatch(
        /<DesignDocBody\b[^<>]*\bmode=\{mode\}[^<>]*\bonChange=\{onChange\}/,
      );
      expect(review).toMatch(
        /<ViewModeSwitch\b[^<>]*\bmode=\{mode\}[^<>]*\bonChange=\{onChange\}/,
      );
    });

    test("spreads no attributes into a part", () => {
      expect(review).not.toMatch(/<[A-Z][A-Za-z]*[^<>]*\{\.\.\./);
    });

    test("draws one switch", () => {
      expect(review.match(/<ViewModeSwitch\b/g)?.length).toBe(1);
    });

    test("does not pass the mode to the issue at intake", () => {
      expect(review).not.toMatch(/<IntakeSnapshotPanel\b[^<>]*\bmode=/);
    });

    test("renders the preview only in the preview branch", () => {
      expect(review.match(/<DesignTextPreview\b/g)?.length).toBe(1);
      expect(review).toMatch(
        /mode === "preview" \? \(\s*<DesignTextPreview text=\{doc\.text\} repo=\{repo\} \/>\s*\) : \(\s*<DesignTextView/,
      );
    });

    test("does not set inner html", () => {
      expect(review).not.toContain("dangerouslySetInnerHTML");
    });

    test("keys the approval bar by the request", () => {
      expect(review).toMatch(
        /<ApprovalBar\s+key=\{approval\.approval_request_id\}/,
      );
    });

    test("does not pass the initial mode from the overview", () => {
      expect(overview).not.toContain("initialMode");
    });
  });

  describe("renders the preview through Markdown only", () => {
    const preview = source("console/src/screens/inbox/DesignTextPreview.tsx");

    test("draws with Markdown", () => {
      expect(preview).toContain("<Markdown");
    });

    test("does not set inner html", () => {
      expect(preview).not.toContain("dangerouslySetInnerHTML");
    });

    test("does not parse raw html", () => {
      expect(preview).not.toContain("rehype-raw");
    });
  });
});
