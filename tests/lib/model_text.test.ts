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

    test("counts no removed reference definition", () => {
      expect(normalize("# plan").stripped_reference_count).toBe(0);
    });

    test("is not cut", () => {
      expect(normalize("# plan").truncated).toBe(false);
    });

    test("reports its length in code points", () => {
      expect(normalize("😀a").original_chars).toBe(2);
    });
  });

  describe("HTML", () => {
    test("keeps a comment as text", () => {
      expect(normalize("a<!-- hidden -->b").text).toBe("a<!-- hidden -->b");
    });

    test("keeps a comment that is never closed as text", () => {
      expect(normalize("visible\n<!-- hidden\nmore").text).toBe(
        "visible\n<!-- hidden\nmore",
      );
    });

    test("keeps a script element as text", () => {
      expect(normalize("a<script>alert(1)</script>b").text).toBe(
        "a<script>alert(1)</script>b",
      );
    });

    test("keeps a style element as text", () => {
      expect(normalize("a<style>p{color:red}</style>b").text).toBe(
        "a<style>p{color:red}</style>b",
      );
    });

    test("keeps a tag with attributes as text", () => {
      expect(normalize('<a href="https://example.com">link</a>').text).toBe(
        '<a href="https://example.com">link</a>',
      );
    });

    test("keeps a generic type in code as it is", () => {
      expect(normalize("returns `Promise<void>` or Promise<void>").text).toBe(
        "returns `Promise<void>` or Promise<void>",
      );
    });

    test("keeps an autolink as it is", () => {
      expect(normalize("see <https://example.com>").text).toBe(
        "see <https://example.com>",
      );
    });

    test("keeps a tag in an inline code span as it is", () => {
      expect(normalize("use `<script>` carefully").text).toBe(
        "use `<script>` carefully",
      );
    });

    test("keeps tags in a fenced code block as they are", () => {
      expect(normalize("```html\n<div>a</div>\n```").text).toBe(
        "```html\n<div>a</div>\n```",
      );
    });

    test("does not report HTML as a change", () => {
      expect(normalize("a<!-- c -->b<script>x</script>").masked).toBe(false);
    });
  });

  describe("idempotence", () => {
    const INPUTS: readonly (readonly [string, string])[] = [
      ["a comment opener split by a zero width space", "a<!​-- hidden -->b"],
      ["a script tag split by a zero width space", "<​script>x</script>"],
      ["a comment opener split by a combining grapheme joiner", "<!͏-- c -->"],
      ["a closing tag split by a combining grapheme joiner", "</͏script>"],
      [
        "a reference definition split by a zero width space",
        "a\n[x]:​ https://example.com\nb",
      ],
      ["a design over the limit", "a".repeat(MAX + 100)],
      [
        "a design over the limit with a definition",
        `[x]: y\n${"a".repeat(MAX + 100)}`,
      ],
      ["a secret", `token ${GITHUB_TOKEN} <!-- c -->`],
    ];

    test.each(INPUTS)(
      "normalizing twice equals once for %s",
      (_name, input) => {
        const once = normalize(input).text;
        expect(normalize(once).text).toBe(once);
      },
    );

    test("drops the zero width space and keeps the comment opener as text", () => {
      expect(normalize("a<!​-- hidden -->b").text).toBe("a<!-- hidden -->b");
    });

    test("keeps the combining grapheme joiner when no secret hides behind it", () => {
      expect(normalize("<!͏-- c -->").text).toBe("<!͏-- c -->");
    });
  });

  describe("link reference definitions", () => {
    test("removes a definition line", () => {
      expect(normalize("text\n[a]: https://example.com\nmore").text).toBe(
        "text\nmore",
      );
    });

    test("counts the removed definition", () => {
      expect(
        normalize("text\n[a]: https://example.com\nmore")
          .stripped_reference_count,
      ).toBe(1);
    });

    test("counts each removed definition", () => {
      expect(
        normalize("[a]: https://a.example\n[b]: https://b.example\ntext")
          .stripped_reference_count,
      ).toBe(2);
    });

    test("removes a definition on the last line", () => {
      expect(normalize("text\n[a]: https://example.com").text).toBe("text");
    });

    test("removes a definition indented by up to three spaces", () => {
      expect(normalize("text\n   [a]: https://example.com\nmore").text).toBe(
        "text\nmore",
      );
    });

    test("keeps a line indented by four spaces, which is a code block", () => {
      expect(normalize("text\n\n    [a]: https://example.com\n").text).toBe(
        "text\n\n    [a]: https://example.com\n",
      );
    });

    test("removes a definition whose separator had a zero width space", () => {
      expect(normalize("a\n[x]:​ https://example.com\nb").text).toBe("a\nb");
    });

    test("removes a definition with a title", () => {
      expect(normalize('[a]: https://example.com "Title"\ntext').text).toBe(
        "text",
      );
    });

    test("keeps a bracket with no colon", () => {
      expect(normalize("- [x] done").text).toBe("- [x] done");
    });

    test("keeps a definition marker in the middle of a line", () => {
      expect(normalize("see [a]: https://example.com").text).toBe(
        "see [a]: https://example.com",
      );
    });

    test("keeps a definition inside a backtick fence", () => {
      expect(normalize("```\n[x]: y\n```\n").text).toBe("```\n[x]: y\n```\n");
    });

    test("keeps a definition inside a tilde fence", () => {
      expect(normalize("~~~\n[x]: y\n~~~\n").text).toBe("~~~\n[x]: y\n~~~\n");
    });

    test("keeps a definition inside a fence that is never closed", () => {
      expect(normalize("```\n[x]: y\nmore").text).toBe("```\n[x]: y\nmore");
    });

    test("does not count a definition inside a fence", () => {
      expect(normalize("```\n[x]: y\n```\n").stripped_reference_count).toBe(0);
    });

    test("removes a definition after the fence is closed", () => {
      expect(normalize("```\ncode\n```\n[x]: y\ntext").text).toBe(
        "```\ncode\n```\ntext",
      );
    });

    test("does not close a fence with a shorter fence", () => {
      expect(normalize("````\n```\n[x]: y\n````\n").text).toBe(
        "````\n```\n[x]: y\n````\n",
      );
    });

    test("does not close a fence with the other kind of fence", () => {
      expect(normalize("```\n~~~\n[x]: y\n```\n").text).toBe(
        "```\n~~~\n[x]: y\n```\n",
      );
    });

    test("removes a definition with a Windows line ending", () => {
      expect(normalize("a\r\n[x]: y\r\nb").text).toBe("a\r\nb");
    });
  });

  describe("secrets and control characters", () => {
    test("masks a secret", () => {
      expect(normalize(`token ${GITHUB_TOKEN}`).text).toBe("token ***");
    });

    test("reports a masked secret", () => {
      expect(normalize(`token ${GITHUB_TOKEN}`).masked).toBe(true);
    });

    test("masks a secret that a zero width space split in two", () => {
      expect(
        normalize(`${GITHUB_TOKEN.slice(0, 12)}​${GITHUB_TOKEN.slice(12)}`).text,
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

    test("measures the length after the definitions are removed", () => {
      expect(
        normalize(`[a]: ${"x".repeat(MAX)}\n${"a".repeat(MAX)}`).truncated,
      ).toBe(false);
    });

    test("keeps a design that fits once its definitions are removed without a mark", () => {
      expect(
        normalize(`[a]: ${"x".repeat(MAX)}\n${"a".repeat(MAX)}`).text,
      ).toBe("a".repeat(MAX));
    });

    test("reports the length after the definitions are removed", () => {
      expect(
        normalize(`[a]: ${"x".repeat(MAX)}\n${"a".repeat(MAX)}`).original_chars,
      ).toBe(MAX);
    });

    test("cuts a design that is one over the limit once its definitions are removed", () => {
      expect(
        normalize(`[a]: ${"x".repeat(MAX)}\n${"a".repeat(MAX + 1)}`).truncated,
      ).toBe(true);
    });

    test("masks before it cuts, so a secret at the cut does not survive", () => {
      expect(
        normalize(`${"a".repeat(MAX - 5)}${GITHUB_TOKEN}`).text,
      ).not.toContain("ghp_");
    });
  });
});
