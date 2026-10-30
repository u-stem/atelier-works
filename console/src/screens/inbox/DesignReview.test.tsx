import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ApprovalDesignDoc } from "../../api/guards/approvalDesignDoc.ts";
import { DesignDocBody, DesignTextView } from "./DesignReview.tsx";

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

function renderBody(overrides: Partial<ApprovalDesignDoc> = {}): string {
  return renderToStaticMarkup(<DesignDocBody doc={{ ...DOC, ...overrides }} />);
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

  test("tells that the text was cut at the limit", () => {
    expect(renderBody({ truncated: true })).toContain("長さの上限で切られて");
  });

  test("does not tell about a cut when the text was not cut", () => {
    expect(renderBody()).not.toContain("長さの上限で切られて");
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
