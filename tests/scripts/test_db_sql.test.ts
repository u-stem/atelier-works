import { describe, expect, test } from "bun:test";
import { renderLiteral, renderSql } from "../../scripts/test-db-sql.ts";

function template(strings: readonly string[]): TemplateStringsArray {
  return Object.assign([...strings], { raw: [...strings] });
}

describe("renderLiteral", () => {
  test("renders a number as is", () => {
    expect(renderLiteral(42)).toBe("42");
  });

  test("rejects a non-finite number", () => {
    expect(() => renderLiteral(Number.NaN)).toThrow("non-finite");
  });

  test("renders booleans", () => {
    expect([renderLiteral(true), renderLiteral(false)]).toEqual([
      "true",
      "false",
    ]);
  });

  test("renders null", () => {
    expect(renderLiteral(null)).toBe("NULL");
  });

  test("quotes a string", () => {
    expect(renderLiteral("abc")).toBe("'abc'");
  });

  test("doubles single quotes in a string", () => {
    expect(renderLiteral("it's")).toBe("'it''s'");
  });

  test("keeps a backslash as is", () => {
    expect(renderLiteral("a\\b")).toBe("'a\\b'");
  });

  test("rejects a string with a NUL character", () => {
    expect(() => renderLiteral("a\u0000b")).toThrow("NUL");
  });

  test("renders a Date as an ISO string", () => {
    expect(renderLiteral(new Date("2026-10-09T00:00:00.000Z"))).toBe(
      "'2026-10-09T00:00:00.000Z'",
    );
  });

  test("renders an array", () => {
    expect(renderLiteral(["a", "b"])).toBe("ARRAY['a', 'b']");
  });

  test("renders an empty array with a text cast", () => {
    expect(renderLiteral([])).toBe("ARRAY[]::text[]");
  });

  test("rejects an unsupported value", () => {
    expect(() => renderLiteral({ a: 1 })).toThrow("unsupported");
  });
});

describe("renderSql", () => {
  test("interleaves strings and rendered values", () => {
    expect(renderSql(template(["SELECT ", "::int, ", ""]), [1, "x"])).toBe(
      "SELECT 1::int, 'x'",
    );
  });

  test("keeps a statement without values as is", () => {
    expect(renderSql(template(["SELECT 1"]), [])).toBe("SELECT 1");
  });
});
