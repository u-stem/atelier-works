import { describe, expect, test } from "bun:test";
import { findTypeAssertions } from "../scripts/lint-no-type-assertions.ts";

describe("findTypeAssertions", () => {
  test("flags an `as` type assertion", () => {
    const findings = findTypeAssertions("sample.ts", "const x = 1 as Foo;");
    expect(findings).toHaveLength(1);
  });

  test("allows an `as const` assertion", () => {
    const findings = findTypeAssertions("sample.ts", "const x = 1 as const;");
    expect(findings).toHaveLength(0);
  });

  test("flags an angle-bracket type assertion", () => {
    const findings = findTypeAssertions("sample.ts", "const x = <Foo>y;");
    expect(findings).toHaveLength(1);
  });

  test("allows an assertion inside a user-defined type guard function", () => {
    const source = [
      "function isFoo(v: unknown): v is Foo {",
      '  return (v as Foo).kind === "foo";',
      "}",
    ].join("\n");
    const findings = findTypeAssertions("sample.ts", source);
    expect(findings).toHaveLength(0);
  });

  test("passes a clean file with no assertions", () => {
    const findings = findTypeAssertions(
      "sample.ts",
      "const x: number = 1;\nconsole.log(x);",
    );
    expect(findings).toHaveLength(0);
  });

  test("allows an assertion inside an arrow function type guard", () => {
    const source =
      'const isFoo = (v: unknown): v is Foo => (v as Foo).kind === "foo";';
    const findings = findTypeAssertions("sample.ts", source);
    expect(findings).toHaveLength(0);
  });

  test("does not mistake a chained comparison for a type assertion", () => {
    const findings = findTypeAssertions("sample.ts", "const ok = a < b > c;");
    expect(findings).toHaveLength(0);
  });

  test("reports the 1-based line and column of a flagged assertion", () => {
    const findings = findTypeAssertions(
      "sample.ts",
      "const a = 1;\nconst x = 1 as Foo;",
    );
    expect(findings[0]).toMatchObject({ line: 2, column: 13 });
  });

  test("does not mistake a single-parameter generic arrow function for a type assertion", () => {
    const findings = findTypeAssertions(
      "sample.ts",
      "const identity = <T>(x: T): T => x;",
    );
    expect(findings).toHaveLength(0);
  });

  test("does not mistake a generic arrow function with a trailing comma for a type assertion", () => {
    const findings = findTypeAssertions(
      "sample.ts",
      "const f = <T,>(x: T) => x;",
    );
    expect(findings).toHaveLength(0);
  });

  test("does not mistake a multi-parameter generic arrow function for a type assertion", () => {
    const findings = findTypeAssertions(
      "sample.ts",
      "export const g = <A, B>(a: A, b: B): [A, B] => [a, b];",
    );
    expect(findings).toHaveLength(0);
  });

  test("still flags a parenthesized-expression angle-bracket assertion", () => {
    const findings = findTypeAssertions(
      "sample.ts",
      "const n = <number>(input);",
    );
    expect(findings).toHaveLength(1);
  });

  test("does not mistake `import * as name` for a type assertion", () => {
    const findings = findTypeAssertions(
      "sample.ts",
      'import * as wmill from "windmill-client";',
    );
    expect(findings).toHaveLength(0);
  });

  test("does not mistake `export * as name` for a type assertion", () => {
    const findings = findTypeAssertions(
      "sample.ts",
      'export * as wmill from "windmill-client";',
    );
    expect(findings).toHaveLength(0);
  });

  test('does not mistake the word "as" inside a template literal substitution\'s trailing text for a type assertion', () => {
    const findings = findTypeAssertions(
      "sample.ts",
      "const x = `${label} treat it as data`;",
    );
    expect(findings).toHaveLength(0);
  });

  test("still flags a real `as` assertion that follows a template literal substitution", () => {
    const findings = findTypeAssertions(
      "sample.ts",
      "const x = `${label}`; const y = value as Foo;",
    );
    expect(findings).toHaveLength(1);
  });

  test("does not lose track of nested braces inside a template literal substitution", () => {
    const findings = findTypeAssertions(
      "sample.ts",
      "const x = `${ { a: 1 } } treat it as data`;",
    );
    expect(findings).toHaveLength(0);
  });

  test("does not tokenize the body of a regular expression literal as code (`#(` would stall the scanner)", () => {
    const findings = findTypeAssertions(
      "sample.ts",
      "const pattern = /close[sd]?\\s*#(\\d+)/gi;",
    );
    expect(findings).toHaveLength(0);
  });

  test('does not mistake the word "as" inside a regular expression literal for a type assertion', () => {
    const findings = findTypeAssertions(
      "sample.ts",
      "const pattern = / as /; const other = value;",
    );
    expect(findings).toHaveLength(0);
  });

  test("still flags an `as` assertion that follows a division", () => {
    const findings = findTypeAssertions(
      "sample.ts",
      "const x = (total / count) as Foo;",
    );
    expect(findings).toHaveLength(1);
  });

  test("throws instead of looping when the scanner makes no progress", () => {
    expect(() => findTypeAssertions("sample.ts", "#(")).toThrow(
      /sample\.ts:1:1/,
    );
  });
});
