import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DrawioFrame } from "./DrawioFrame.tsx";

const XML = '<mxfile><diagram name="a"><mxGraphModel/></diagram></mxfile>';

function markup(): string {
  return renderToStaticMarkup(<DrawioFrame xml={XML} title="図" />);
}

/** iframeを直接包む要素の開始タグ。 */
function iframeParentTag(html: string): string {
  const found = /(<div [^>]*>)<iframe /.exec(html);
  if (found === null) throw new Error(`no wrapper in ${html}`);
  return found[1] ?? "";
}

/** 枠線を持つ外側の要素の開始タグ。 */
function borderedTag(html: string): string {
  const found = /<div [^>]*\bborder-border\b[^>]*>/.exec(html);
  if (found === null) throw new Error(`no border in ${html}`);
  return found[0];
}

describe("DrawioFrame in the dark theme", () => {
  test("inverts the wrapper around the iframe only in the dark theme", () => {
    expect(iframeParentTag(markup())).toContain("in-data-[theme=dark]:invert");
  });

  test("rotates the hue back so the colors keep their meaning", () => {
    expect(iframeParentTag(markup())).toContain(
      "in-data-[theme=dark]:hue-rotate-180",
    );
  });

  test("keeps the border outside the inverted wrapper", () => {
    expect(borderedTag(markup())).not.toContain("invert");
  });

  test("does not invert the iframe in the light theme", () => {
    expect(iframeParentTag(markup())).not.toMatch(/(^|[\s"])invert\b/);
  });
});
