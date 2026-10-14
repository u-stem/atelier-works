import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { splitNoticeMessage } from "../../lib/noticeView.ts";
import { NoticeMessageText } from "./NoticeMessageText.tsx";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function render(message: string): string {
  return renderToStaticMarkup(
    <NoticeMessageText parts={splitNoticeMessage(message)} />,
  );
}

describe("NoticeMessageText", () => {
  test("shows a version as its first seven characters", () => {
    expect(render(`deployed(${SHA})`)).toContain(">0123456</code>");
  });

  test("keeps the full version in the title", () => {
    expect(render(`deployed(${SHA})`)).toContain(`title="${SHA}"`);
  });

  test("offers a button to copy the full version", () => {
    expect(render(`deployed(${SHA})`)).toContain(
      'aria-label="版0123456の全体を複製"',
    );
  });

  test("shows the text around the version", () => {
    expect(render(`deployed(${SHA}) is behind`)).toContain(") is behind");
  });

  test("offers no copy button for a body without a version", () => {
    expect(render("disk full")).not.toContain("<button");
  });

  test("escapes markup in the body", () => {
    expect(render("<b>x</b>")).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});
