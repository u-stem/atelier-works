import { describe, expect, test } from "bun:test";
import { sanitizeDisplayText } from "./sanitizeDisplayText.ts";

describe("sanitizeDisplayText", () => {
  test("keeps plain text as it is", () => {
    expect(sanitizeDisplayText("Add feature: 要件定義の生成")).toBe(
      "Add feature: 要件定義の生成",
    );
  });

  test("returns an empty string for an empty string", () => {
    expect(sanitizeDisplayText("")).toBe("");
  });

  test.each([
    ["U+202A left-to-right embedding", "\u{202A}"],
    ["U+202B right-to-left embedding", "\u{202B}"],
    ["U+202C pop directional formatting", "\u{202C}"],
    ["U+202D left-to-right override", "\u{202D}"],
    ["U+202E right-to-left override", "\u{202E}"],
    ["U+2066 left-to-right isolate", "\u{2066}"],
    ["U+2067 right-to-left isolate", "\u{2067}"],
    ["U+2068 first strong isolate", "\u{2068}"],
    ["U+2069 pop directional isolate", "\u{2069}"],
    ["U+200E left-to-right mark", "\u{200E}"],
    ["U+200F right-to-left mark", "\u{200F}"],
    ["U+061C arabic letter mark", "\u{61C}"],
  ])("drops %s", (_name, char) => {
    expect(sanitizeDisplayText(`a${char}b`)).toBe("ab");
  });

  test.each([
    ["U+200B zero width space", "\u{200B}"],
    ["U+2060 word joiner", "\u{2060}"],
    ["U+2061 function application", "\u{2061}"],
    ["U+2064 invisible plus", "\u{2064}"],
    ["U+FEFF zero width no-break space", "\u{FEFF}"],
    ["U+180E mongolian vowel separator", "\u{180E}"],
    ["U+206A inhibit symmetric swapping", "\u{206A}"],
    ["U+206F nominal digit shapes", "\u{206F}"],
  ])("drops %s", (_name, char) => {
    expect(sanitizeDisplayText(`a${char}b`)).toBe("ab");
  });

  test("drops tag characters", () => {
    expect(sanitizeDisplayText("a\u{E0001}\u{E0041}\u{E007F}b")).toBe("ab");
  });

  test("keeps the zero width joiner of an emoji sequence", () => {
    expect(sanitizeDisplayText("👨\u{200D}👩\u{200D}👧")).toBe(
      "👨\u{200D}👩\u{200D}👧",
    );
  });

  test("keeps the zero width non-joiner", () => {
    expect(sanitizeDisplayText("a\u{200C}b")).toBe("a\u{200C}b");
  });

  test("keeps a line feed", () => {
    expect(sanitizeDisplayText("a\nb")).toBe("a\nb");
  });

  test("keeps a tab", () => {
    expect(sanitizeDisplayText("a\tb")).toBe("a\tb");
  });

  test("drops a carriage return", () => {
    expect(sanitizeDisplayText("a\r\nb")).toBe("a\nb");
  });

  test.each([
    ["NUL", "\u0000"],
    ["BEL", "\u0007"],
    ["ESC", "\u001B"],
    ["DEL", "\u007F"],
    ["NEL", "\u0085"],
    ["C1 control", "\u009B"],
  ])("drops the control character %s", (_name, char) => {
    expect(sanitizeDisplayText(`a${char}b`)).toBe("ab");
  });

  test("turns a line separator into a line feed", () => {
    expect(sanitizeDisplayText("a\u{2028}b")).toBe("a\nb");
  });

  test("turns a paragraph separator into a line feed", () => {
    expect(sanitizeDisplayText("a\u{2029}b")).toBe("a\nb");
  });

  test("shows the visible text of a reordering attack in the written order", () => {
    expect(sanitizeDisplayText("approve \u{202E}txt.exe\u{202C} now")).toBe(
      "approve txt.exe now",
    );
  });

  test("does not trim the text", () => {
    expect(sanitizeDisplayText("  a  ")).toBe("  a  ");
  });
});
