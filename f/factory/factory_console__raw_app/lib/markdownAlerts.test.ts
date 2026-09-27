import { describe, expect, test } from "bun:test";
import { stripAlertMarker } from "./markdownAlerts";

describe("stripAlertMarker", () => {
  test("strips a [!NOTE] marker", () => {
    const result = stripAlertMarker("[!NOTE]\n本文");
    expect(result?.kind).toBe("note");
  });

  test("returns the remaining text after the marker", () => {
    const result = stripAlertMarker("[!NOTE] 本文");
    expect(result?.rest).toBe("本文");
  });

  test("recognizes [!WARNING]", () => {
    const result = stripAlertMarker("[!WARNING] 注意");
    expect(result?.kind).toBe("warning");
  });

  test("recognizes [!IMPORTANT]", () => {
    const result = stripAlertMarker("[!IMPORTANT] 重要");
    expect(result?.kind).toBe("important");
  });

  test("is case-insensitive", () => {
    const result = stripAlertMarker("[!note] 本文");
    expect(result?.kind).toBe("note");
  });

  test("returns null when there is no marker", () => {
    const result = stripAlertMarker("ただの引用");
    expect(result).toBeNull();
  });

  test("returns null for an unrecognized marker kind", () => {
    const result = stripAlertMarker("[!TIP] 本文");
    expect(result).toBeNull();
  });
});
