import { describe, expect, test } from "bun:test";
import { resolveMarkdownLink } from "./markdownLink";

const ISSUE = "https://github.com/o/r/issues/3";

describe("resolveMarkdownLink", () => {
  test("links a GitHub issue URL whose label is the URL itself", () => {
    expect(resolveMarkdownLink(ISSUE, ISSUE)).toEqual({
      kind: "link",
      href: ISSUE,
      external: true,
      note: null,
    });
  });

  test("shows the URL next to a GitHub link whose label differs", () => {
    expect(resolveMarkdownLink(ISSUE, "see this")).toEqual({
      kind: "link",
      href: ISSUE,
      external: true,
      note: ISSUE,
    });
  });

  test("links a pull request URL", () => {
    const url = "https://github.com/o/r/pull/4";
    expect(resolveMarkdownLink(url, url).kind).toBe("link");
  });

  test("links a fragment that has the shape of a heading slug", () => {
    expect(resolveMarkdownLink("#overview-2", "overview")).toEqual({
      kind: "link",
      href: "#overview-2",
      external: false,
      note: null,
    });
  });

  test("links a Japanese fragment after percent-decoding it", () => {
    const encoded = encodeURIComponent("概要・背景");
    expect(resolveMarkdownLink(`#${encoded}`, "概要")).toEqual({
      kind: "link",
      href: "#概要・背景",
      external: false,
      note: null,
    });
  });

  test.each([
    ["javascript scheme", "javascript:alert(1)"],
    ["javascript scheme in upper case", "JavaScript:alert(1)"],
    ["data scheme", "data:text/html,<script>alert(1)</script>"],
    ["vbscript scheme", "vbscript:msgbox(1)"],
    ["plain http", "http://github.com/o/r/issues/3"],
    ["another host", "https://evil.example/o/r/issues/3"],
    ["host suffix", "https://github.com.evil.example/o/r/issues/3"],
    [
      "user info before the host",
      "https://github.com@evil.example/o/r/issues/3",
    ],
    ["user info after github.com", "https://user:pw@github.com/o/r/issues/3"],
    ["upper case host", "https://GITHUB.com/o/r/issues/3"],
    ["upper case scheme", "HTTPS://github.com/o/r/issues/3"],
    ["another github path", "https://github.com/o/r/blob/main/a.md"],
    ["github profile", "https://github.com/o"],
    ["query string", "https://github.com/o/r/issues/3?x=1"],
    ["trailing fragment", "https://github.com/o/r/issues/3#issuecomment-1"],
    ["trailing newline", "https://github.com/o/r/issues/3\n"],
    ["protocol relative", "//evil.example/x"],
    ["relative path", "../x"],
    ["mailto", "mailto:a@example.com"],
    ["empty", ""],
    ["bare hash", "#"],
    ["upper case fragment", "#Overview"],
    ["fragment with a space", "#a b"],
    ["fragment with a slash", "#a/b"],
    ["fragment with a leading hyphen", "#-a"],
    ["fragment with repeated hyphens", "#a--b"],
    ["fragment with a malformed escape", "#%E0%A4%A"],
    ["fragment with an encoded control character", "#a%00b"],
    ["fragment with a query", "#a?b=1"],
  ])("renders %s as text", (_name, href) => {
    expect(resolveMarkdownLink(href, "label").kind).toBe("text");
  });

  test("renders a missing href as text without a note", () => {
    expect(resolveMarkdownLink(undefined, "label")).toEqual({
      kind: "text",
      note: null,
    });
  });

  test("shows the rejected URL as the note when the label differs", () => {
    expect(resolveMarkdownLink("javascript:alert(1)", "click")).toEqual({
      kind: "text",
      note: "javascript:alert(1)",
    });
  });

  test("omits the note when the rejected URL is the label itself", () => {
    expect(
      resolveMarkdownLink("http://evil.example/", "http://evil.example/"),
    ).toEqual({
      kind: "text",
      note: null,
    });
  });

  test("shows the URL when the label is empty", () => {
    expect(resolveMarkdownLink("http://evil.example/", "")).toEqual({
      kind: "text",
      note: "http://evil.example/",
    });
  });

  test("ignores surrounding whitespace in the label when comparing", () => {
    expect(resolveMarkdownLink(ISSUE, ` ${ISSUE} `)).toMatchObject({
      note: null,
    });
  });

  test("shortens a very long rejected URL in the note", () => {
    const href = `data:text/plain,${"a".repeat(500)}`;
    const result = resolveMarkdownLink(href, "x");
    expect(result.note?.length).toBeLessThanOrEqual(201);
  });
});
