import { describe, expect, test } from "bun:test";
import {
  parseContainerId,
  parseCsvRows,
  psqlArgv,
  renderLiteral,
  renderSql,
} from "../../scripts/test-db-sql.ts";

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

describe("parseCsvRows", () => {
  test("keys the values of a row by the header", () => {
    expect(parseCsvRows("id,state\n31,fixing")).toEqual([
      { id: "31", state: "fixing" },
    ]);
  });

  test("returns every row", () => {
    expect(parseCsvRows("id\n1\n2")).toEqual([{ id: "1" }, { id: "2" }]);
  });

  test("reads a header followed by an empty line as one row of null", () => {
    expect(parseCsvRows("id\n")).toEqual([{ id: null }]);
  });

  test("returns no row for a header only", () => {
    expect(parseCsvRows("id")).toEqual([]);
  });

  test("returns no row for an empty output", () => {
    expect(parseCsvRows("")).toEqual([]);
  });

  test("reads an empty unquoted value as null", () => {
    expect(parseCsvRows("a,b\n1,")).toEqual([{ a: "1", b: null }]);
  });

  test("reads an empty quoted value as an empty string", () => {
    expect(parseCsvRows('a,b\n1,""')).toEqual([{ a: "1", b: "" }]);
  });

  test("keeps a comma inside quotes", () => {
    expect(parseCsvRows('a\n"x,y"')).toEqual([{ a: "x,y" }]);
  });

  test("keeps a line break inside quotes", () => {
    expect(parseCsvRows('a\n"x\ny"')).toEqual([{ a: "x\ny" }]);
  });

  test("reads two quotes inside quotes as one quote", () => {
    expect(parseCsvRows('a\n"say ""hi"""')).toEqual([{ a: 'say "hi"' }]);
  });
});

describe("psqlArgv", () => {
  const id = "0123456789ab";

  test("runs psql inside the container with the plain output options", () => {
    expect(psqlArgv(id, "scratch", "plain")).toEqual([
      "docker",
      "exec",
      "-i",
      id,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "scratch",
      "-q",
      "-t",
      "-A",
    ]);
  });

  test("runs psql with --csv for the csv format", () => {
    expect(psqlArgv(id, "scratch", "csv")).toEqual([
      "docker",
      "exec",
      "-i",
      id,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "scratch",
      "-q",
      "--csv",
    ]);
  });
});

describe("parseContainerId", () => {
  const id = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  test("accepts a 64 character id", () => {
    expect(parseContainerId(id)).toBe(id);
  });

  test("accepts a 12 character id", () => {
    expect(parseContainerId("0123456789ab")).toBe("0123456789ab");
  });

  test("drops the trailing newline of the command output", () => {
    expect(parseContainerId(`${id}\n`)).toBe(id);
  });

  test("rejects an empty output", () => {
    expect(() => parseContainerId("")).toThrow("container id");
  });

  test("rejects an output of only a newline", () => {
    expect(() => parseContainerId("\n")).toThrow("container id");
  });

  test("rejects two ids on separate lines", () => {
    expect(() => parseContainerId(`${id}\n${id}\n`)).toThrow("container id");
  });

  test("rejects a character that is not lowercase hex", () => {
    expect(() => parseContainerId("0123456789az")).toThrow("container id");
  });

  test("rejects an uppercase hex id", () => {
    expect(() => parseContainerId("0123456789AB")).toThrow("container id");
  });

  test("rejects an id shorter than 12 characters", () => {
    expect(() => parseContainerId("0123456789a")).toThrow("container id");
  });

  test("rejects an id longer than 64 characters", () => {
    expect(() => parseContainerId(`${id}0`)).toThrow("container id");
  });
});
