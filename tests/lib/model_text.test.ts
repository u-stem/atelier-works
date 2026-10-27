import { describe, expect, test } from "bun:test";
import {
  DESIGN_FOR_IMPLEMENT_MAX_CHARS,
  FORMAT_CHARACTER_PATTERN,
  GAP_REPORT_MAX_CHARS,
  INVISIBLE_PATTERN,
  isAllowedCharacter,
  normalizeDesignForImplement,
  sanitizeModelText,
  sanitizeModelTextDetailed,
} from "../../f/factory/lib/model_text.ts";
import { MAX_DOC_CHARS } from "../../f/factory/lib/requirements_template.ts";

const GITHUB_TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";

describe("GAP_REPORT_MAX_CHARS", () => {
  test("is 2000", () => {
    expect(GAP_REPORT_MAX_CHARS).toBe(2000);
  });
});

describe("FORMAT_CHARACTER_PATTERN", () => {
  test("matches a zero width space", () => {
    expect(FORMAT_CHARACTER_PATTERN.test("\u{200B}")).toBe(true);
  });

  test("does not match a letter", () => {
    expect(FORMAT_CHARACTER_PATTERN.test("a")).toBe(false);
  });
});

describe("INVISIBLE_PATTERN", () => {
  test("matches a variation selector", () => {
    expect(INVISIBLE_PATTERN.test("\u{FE0F}")).toBe(true);
  });

  test("does not match a Japanese letter", () => {
    expect(INVISIBLE_PATTERN.test("あ")).toBe(false);
  });
});

describe("isAllowedCharacter", () => {
  test("allows a letter", () => {
    expect(isAllowedCharacter("a")).toBe(true);
  });

  test("allows a newline", () => {
    expect(isAllowedCharacter("\n")).toBe(true);
  });

  test("rejects NUL", () => {
    expect(isAllowedCharacter("\u0000")).toBe(false);
  });

  test("rejects a zero width space", () => {
    expect(isAllowedCharacter("\u{200B}")).toBe(false);
  });
});

describe("sanitizeModelText", () => {
  /** 秘密情報の途中に、見えない文字を挟んだ文字列。 */
  function splitToken(invisible: string): string {
    const middle = Math.floor(GITHUB_TOKEN.length / 2);
    return `${GITHUB_TOKEN.slice(0, middle)}${invisible}${GITHUB_TOKEN.slice(middle)}`;
  }

  test("masks a token with a zero width space in the middle", () => {
    expect(sanitizeModelText(splitToken("\u{200B}"), 1000)).not.toContain(
      "ghp_",
    );
  });

  test("masks a token with a zero width joiner in the middle", () => {
    expect(sanitizeModelText(splitToken("\u{200D}"), 1000)).not.toContain(
      "ghp_",
    );
  });

  test("masks a token with a word joiner in the middle", () => {
    expect(sanitizeModelText(splitToken("\u{2060}"), 1000)).not.toContain(
      "ghp_",
    );
  });

  test("masks a token with a C1 control character in the middle", () => {
    expect(sanitizeModelText(splitToken("\u0085"), 1000)).not.toContain("ghp_");
  });

  test("masks a token with a byte order mark in the middle", () => {
    expect(sanitizeModelText(splitToken("\u{FEFF}"), 1000)).not.toContain(
      "ghp_",
    );
  });

  test.each([
    ["a variation selector", "\u{FE0F}"],
    ["a combining grapheme joiner", "\u{034F}"],
    ["a Hangul choseong filler", "\u{115F}"],
    ["a Hangul jungseong filler", "\u{1160}"],
    ["a Hangul filler", "\u{3164}"],
    ["a halfwidth Hangul filler", "\u{FFA0}"],
    ["a braille pattern blank", "\u{2800}"],
    ["a variation selector supplement", "\u{E0100}"],
    ["a combining enclosing mark", "\u{20DD}"],
    ["a Mongolian free variation selector", "\u{180B}"],
  ])("masks a token with %s in the middle", (_name, invisible) => {
    expect(sanitizeModelText(splitToken(invisible), 1000)).toBe("***");
  });

  test("masks a token with several invisible characters in the middle", () => {
    expect(
      sanitizeModelText(splitToken("\u{FE0F}\u{200B}\u{3164}\u{2800}"), 1000),
    ).toBe("***");
  });

  test("masks a token that is followed by text with an invisible character", () => {
    expect(sanitizeModelText(`前${splitToken("\u{FE0F}")}後`, 1000)).toBe(
      "前***後",
    );
  });

  test("keeps the combining voiced sound marks of Japanese text", () => {
    expect(sanitizeModelText("か\u{3099}き\u{309A}", 1000)).toBe(
      "か\u{3099}き\u{309A}",
    );
  });

  test("keeps an ideographic variation sequence", () => {
    expect(sanitizeModelText("葛\u{E0100}城", 1000)).toBe("葛\u{E0100}城");
  });

  test("keeps an emoji variation selector", () => {
    expect(sanitizeModelText("\u{2764}\u{FE0F}", 1000)).toBe(
      "\u{2764}\u{FE0F}",
    );
  });

  test("removes a right to left override", () => {
    expect(sanitizeModelText("a\u{202E}b", 1000)).toBe("ab");
  });

  test("removes the other bidirectional controls", () => {
    expect(
      sanitizeModelText(
        "a\u{200E}\u{200F}\u{202A}\u{202B}\u{202C}\u{202D}\u{2066}\u{2069}b",
        1000,
      ),
    ).toBe("ab");
  });

  test("removes a C1 control character at both ends of its range", () => {
    expect(sanitizeModelText("a\u0080\u009Fb", 1000)).toBe("ab");
  });

  test("removes a soft hyphen", () => {
    expect(sanitizeModelText("a\u{00AD}b", 1000)).toBe("ab");
  });

  test("removes a delete character", () => {
    expect(sanitizeModelText("a\u007Fb", 1000)).toBe("ab");
  });

  test("keeps Japanese text, a newline and a tab", () => {
    expect(sanitizeModelText("設計\n方針\t要約", 1000)).toBe(
      "設計\n方針\t要約",
    );
  });

  test("keeps the no-break space, which is a space and not a format character", () => {
    expect(sanitizeModelText("a\u{00A0}b", 1000)).toBe("a\u{00A0}b");
  });

  test("cuts a long text at a code point boundary", () => {
    expect(sanitizeModelText("😀😀😀", 2)).toBe("😀😀");
  });

  test("keeps a text of exactly the limit", () => {
    expect(sanitizeModelText("abcd", 4)).toBe("abcd");
  });
});

describe("sanitizeModelTextDetailed", () => {
  test("returns the whole text without cutting it", () => {
    expect(sanitizeModelTextDetailed("a".repeat(5000)).text).toBe(
      "a".repeat(5000),
    );
  });

  test("counts the code points of the text", () => {
    expect(sanitizeModelTextDetailed("😀😀a").chars).toBe(3);
  });

  test("counts the code points after removing control characters", () => {
    expect(sanitizeModelTextDetailed("a\u0000b​c").chars).toBe(3);
  });

  test("masks a secret", () => {
    expect(sanitizeModelTextDetailed(`x ${GITHUB_TOKEN}`).text).toBe("x ***");
  });

  test("reports that a secret was masked", () => {
    expect(sanitizeModelTextDetailed(`x ${GITHUB_TOKEN}`).masked).toBe(true);
  });

  test("reports that nothing was masked in a plain text", () => {
    expect(sanitizeModelTextDetailed("plain").masked).toBe(false);
  });

  test("reports a secret that is split by a combining mark as masked", () => {
    const split = `${GITHUB_TOKEN.slice(0, 10)}́${GITHUB_TOKEN.slice(10)}`;
    expect(sanitizeModelTextDetailed(split).masked).toBe(true);
  });

  test("reports that combining marks were dropped when they hid a secret", () => {
    const split = `${GITHUB_TOKEN.slice(0, 10)}́${GITHUB_TOKEN.slice(10)}`;
    expect(sanitizeModelTextDetailed(split).dropped_combining).toBe(true);
  });

  test("reports that no combining mark was dropped from a plain text with a combining mark", () => {
    expect(sanitizeModelTextDetailed("が").dropped_combining).toBe(false);
  });

  test("keeps the combining mark of a plain text", () => {
    expect(sanitizeModelTextDetailed("が").text).toBe("が");
  });

  test("reports that no combining mark was dropped when a plain secret was masked", () => {
    expect(
      sanitizeModelTextDetailed(`x ${GITHUB_TOKEN}`).dropped_combining,
    ).toBe(false);
  });

  test("returns the same text as sanitizeModelText under the limit", () => {
    const text = `a\u0000b ${GITHUB_TOKEN} c`;
    expect(sanitizeModelTextDetailed(text).text).toBe(
      sanitizeModelText(text, 1000),
    );
  });
});

describe("DESIGN_FOR_IMPLEMENT_MAX_CHARS", () => {
  test("is the size limit of a design document", () => {
    expect(DESIGN_FOR_IMPLEMENT_MAX_CHARS).toBe(MAX_DOC_CHARS);
  });
});

describe("normalizeDesignForImplement", () => {
  const MAX = 8000;

  function normalize(markdown: string, maxChars = MAX) {
    return normalizeDesignForImplement(markdown, maxChars);
  }

  describe("a design that needs no change", () => {
    test("is returned as it is", () => {
      expect(normalize("# plan\n\nbody\n").text).toBe("# plan\n\nbody\n");
    });

    test("counts no stripped element", () => {
      expect(normalize("# plan").stripped_html_count).toBe(0);
    });

    test("is not cut", () => {
      expect(normalize("# plan").truncated).toBe(false);
    });

    test("reports its length in code points", () => {
      expect(normalize("😀a").original_chars).toBe(2);
    });
  });

  describe("HTML comments", () => {
    test("removes a comment", () => {
      expect(normalize("a<!-- hidden -->b").text).toBe("ab");
    });

    test("removes a comment over several lines", () => {
      expect(normalize("a<!--\nline\nline\n-->b").text).toBe("ab");
    });

    test("removes a comment that is never closed up to the end", () => {
      expect(normalize("visible\n<!-- hidden\nmore").text).toBe("visible\n");
    });

    test("removes several comments", () => {
      expect(normalize("a<!-- 1 -->b<!-- 2 -->c").text).toBe("abc");
    });

    test("counts each comment", () => {
      expect(normalize("a<!-- 1 -->b<!-- 2 -->c").stripped_html_count).toBe(2);
    });

    test("counts a comment that is never closed", () => {
      expect(normalize("a<!-- hidden").stripped_html_count).toBe(1);
    });

    test("removes a comment that another comment was hiding inside", () => {
      expect(normalize("a<!<!-- x -->-- y -->b").text).toBe("ab");
    });
  });

  describe("script and style elements", () => {
    test("removes a script element with its content", () => {
      expect(normalize("a<script>alert(1)</script>b").text).toBe("ab");
    });

    test("removes a style element with its content", () => {
      expect(normalize("a<style>p{color:red}</style>b").text).toBe("ab");
    });

    test("removes a script element whatever the case", () => {
      expect(normalize("a<SCRIPT>x</Script >b").text).toBe("ab");
    });

    test("removes a script element with attributes", () => {
      expect(normalize('a<script src="x.js">y</script>b').text).toBe("ab");
    });

    test("removes a script element that is never closed up to the end", () => {
      expect(normalize("a<script>x\nrest").text).toBe("a");
    });

    test("counts a script element as one", () => {
      expect(
        normalize("a<script>x</script>b<style>y</style>c").stripped_html_count,
      ).toBe(2);
    });
  });

  describe("raw HTML tags", () => {
    test("removes an opening tag and keeps the text", () => {
      expect(normalize("a<div>text</div>b").text).toBe("atextb");
    });

    test("removes a tag with attributes", () => {
      expect(normalize('<a href="https://example.com">link</a>').text).toBe(
        "link",
      );
    });

    test("removes a self-closing tag", () => {
      expect(normalize("a<br/>b").text).toBe("ab");
    });

    test("removes a declaration", () => {
      expect(normalize("<!DOCTYPE html>a").text).toBe("a");
    });

    test("does not leave a script tag that another tag was hiding inside", () => {
      expect(normalize("a<scr<b>ipt>x</p>b").text).not.toContain("<script");
    });

    test("counts each tag", () => {
      expect(normalize("<p>a</p>").stripped_html_count).toBe(2);
    });

    test("keeps a less-than sign that does not start a tag", () => {
      expect(normalize("1 < 2 and 3 > 2").text).toBe("1 < 2 and 3 > 2");
    });

    test("keeps a tag that is never closed", () => {
      expect(normalize("a <div").text).toBe("a <div");
    });
  });

  describe("secrets and control characters", () => {
    test("masks a secret", () => {
      expect(normalize(`token ${GITHUB_TOKEN}`).text).toBe("token ***");
    });

    test("reports a masked secret", () => {
      expect(normalize(`token ${GITHUB_TOKEN}`).masked).toBe(true);
    });

    test("masks a secret that a comment split in two", () => {
      expect(
        normalize(
          `${GITHUB_TOKEN.slice(0, 12)}<!-- x -->${GITHUB_TOKEN.slice(12)}`,
        ).text,
      ).toBe("***");
    });

    test("masks a secret that a closing tag split in two", () => {
      expect(
        normalize(`${GITHUB_TOKEN.slice(0, 12)}</b>${GITHUB_TOKEN.slice(12)}`)
          .text,
      ).toBe("***");
    });

    test("removes a control character", () => {
      expect(normalize("a\u0000b").text).toBe("ab");
    });

    test("reports a dropped combining mark", () => {
      const split = `${GITHUB_TOKEN.slice(0, 10)}́${GITHUB_TOKEN.slice(10)}`;
      expect(normalize(split).dropped_combining).toBe(true);
    });
  });

  describe("the size limit", () => {
    test("keeps a design of exactly the limit", () => {
      expect(normalize("a".repeat(MAX)).text).toBe("a".repeat(MAX));
    });

    test("does not mark a design of exactly the limit as cut", () => {
      expect(normalize("a".repeat(MAX)).truncated).toBe(false);
    });

    test("cuts a design one over the limit", () => {
      expect(normalize("a".repeat(MAX + 1)).text).toBe(
        `${"a".repeat(MAX)}\n[the design was truncated]`,
      );
    });

    test("marks a design one over the limit as cut", () => {
      expect(normalize("a".repeat(MAX + 1)).truncated).toBe(true);
    });

    test("reports the length before the cut", () => {
      expect(normalize("a".repeat(MAX + 5)).original_chars).toBe(MAX + 5);
    });

    test("reports the length that was kept", () => {
      expect(normalize("a".repeat(MAX + 5)).kept_chars).toBe(MAX);
    });

    test("cuts at a code point boundary", () => {
      expect(normalize("😀😀😀", 2).text).toBe(
        "😀😀\n[the design was truncated]",
      );
    });

    test("measures the length after the HTML is removed", () => {
      expect(
        normalize(`a<!--${"x".repeat(MAX)}-->${"a".repeat(MAX - 1)}`).truncated,
      ).toBe(false);
    });

    test("keeps a design that fits once the HTML is removed without a mark", () => {
      expect(
        normalize(`a<!--${"x".repeat(MAX)}-->${"a".repeat(MAX - 1)}`).text,
      ).toBe("a".repeat(MAX));
    });

    test("reports the length after the HTML is removed", () => {
      expect(
        normalize(`a<!--${"x".repeat(MAX)}-->${"a".repeat(MAX - 1)}`)
          .original_chars,
      ).toBe(MAX);
    });

    test("cuts a design that is one over the limit once the HTML is removed", () => {
      expect(
        normalize(`a<!--${"x".repeat(MAX)}-->${"a".repeat(MAX)}`).truncated,
      ).toBe(true);
    });

    test("masks before it cuts, so a secret at the cut does not survive", () => {
      expect(
        normalize(`${"a".repeat(MAX - 5)}${GITHUB_TOKEN}`).text,
      ).not.toContain("ghp_");
    });
  });
});
