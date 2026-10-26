import { describe, expect, test } from "bun:test";
import {
  FORMAT_CHARACTER_PATTERN,
  GAP_REPORT_MAX_CHARS,
  INVISIBLE_PATTERN,
  isAllowedCharacter,
  sanitizeModelText,
} from "../../f/factory/lib/model_text.ts";

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
