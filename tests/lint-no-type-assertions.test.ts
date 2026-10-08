import { describe, expect, test } from "bun:test";
import {
  DEFAULT_GLOBS,
  findTypeAssertions,
} from "../scripts/lint-no-type-assertions.ts";

describe("DEFAULT_GLOBS", () => {
  test("covers the console and console_fetcher TypeScript sources", () => {
    expect(DEFAULT_GLOBS).toEqual(
      expect.arrayContaining([
        "console/*.{ts,tsx}",
        "console/src/**/*.{ts,tsx}",
        "console/scripts/**/*.{ts,tsx}",
        "infra/console_fetcher/**/*.{ts,tsx}",
      ]),
    );
  });
});

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

  test("does not flag a `satisfies` expression", () => {
    const findings = findTypeAssertions(
      "sample.ts",
      "const x = { a: 1 } satisfies Foo;",
    );
    expect(findings).toHaveLength(0);
  });

  test("reads `>>` closing nested generics as two tokens", () => {
    const source = "const a: Array<Array<Foo>> = [];\nconst b = y as Foo;";
    const findings = findTypeAssertions("sample.ts", source);
    expect(findings.map((f) => f.line)).toEqual([2]);
  });

  test("flags an angle-bracket assertion to a nested generic type at its position", () => {
    const findings = findTypeAssertions(
      "sample.ts",
      "const x = <Array<Foo>>y;",
    );
    expect(findings.map((f) => [f.line, f.column])).toEqual([[1, 11]]);
  });

  test("treats a slash after a keyword-named property as division, not a regular expression", () => {
    const source = "const y = r.type / 2; const t = '/'; const q = z as Foo;";
    const findings = findTypeAssertions("sample.ts", source);
    expect(findings).toHaveLength(1);
  });

  test("treats a slash after a non-null assertion as division, not a regular expression", () => {
    const source = 'const r = x! / 2; const t = "/"; const b = y as Foo;';
    const findings = findTypeAssertions("sample.ts", source);
    expect(findings).toHaveLength(1);
  });
});

describe("findTypeAssertions on .tsx", () => {
  const lines = (findings: readonly { line: number }[]) =>
    findings.map((f) => f.line);

  test("flags an `as` assertion inside a JSX attribute expression", () => {
    const source = "const z = 1;\nconst a = <Foo value={x as Bar} />;";
    expect(lines(findTypeAssertions("sample.tsx", source))).toEqual([2]);
  });

  test("flags an `as` assertion inside a JSX child expression", () => {
    const source = "const z = 1;\nconst a = <div>{(x as Bar).name}</div>;";
    expect(lines(findTypeAssertions("sample.tsx", source))).toEqual([2]);
  });

  test("allows `as const` inside a JSX expression", () => {
    const source = "const a = <Foo v={[1] as const} />;\nconst b = y as Foo;";
    expect(lines(findTypeAssertions("sample.tsx", source))).toEqual([2]);
  });

  test("does not flag `satisfies` inside a JSX expression", () => {
    const source =
      "const a = <Foo v={x satisfies Bar} />;\nconst b = y as Foo;";
    expect(lines(findTypeAssertions("sample.tsx", source))).toEqual([2]);
  });

  test("reads `>>` closing nested generics in a type annotation", () => {
    const source = "const a: Array<Array<Foo>> = [];\nconst b = y as Foo;";
    expect(lines(findTypeAssertions("sample.tsx", source))).toEqual([2]);
  });

  test("reads `>>` closing nested type arguments of a JSX tag", () => {
    const source = "const a = <Foo<Array<string>> />;\nconst b = y as Foo;";
    expect(lines(findTypeAssertions("sample.tsx", source))).toEqual([2]);
  });

  test("treats a generic arrow function with a default type parameter as code", () => {
    const source = "const g = <T = string>(v: T) => v;\nconst b = y as Foo;";
    expect(lines(findTypeAssertions("sample.tsx", source))).toEqual([2]);
  });

  test("treats a generic arrow function with a const type parameter as code", () => {
    const source = "const g = <const T,>(v: T) => v;\nconst b = y as Foo;";
    expect(lines(findTypeAssertions("sample.tsx", source))).toEqual([2]);
  });

  test("reads a JSX tag with type arguments", () => {
    const source = 'const a = <Foo<string> prop="x" />;\nconst b = y as Foo;';
    expect(lines(findTypeAssertions("sample.tsx", source))).toEqual([2]);
  });

  test("does not treat a generic function type in a type alias as JSX", () => {
    const source = "type Fn = <T>(x: T) => T;\nconst b = y as Foo;";
    expect(lines(findTypeAssertions("sample.tsx", source))).toEqual([2]);
  });

  test("does not treat a generic function type in an interface member as JSX", () => {
    const source = "interface I { m: <T>(x: T) => T }\nconst b = y as Foo;";
    expect(lines(findTypeAssertions("sample.tsx", source))).toEqual([2]);
  });

  test("reports an error instead of silently skipping a generic call signature misread as JSX", () => {
    const source = "interface I { <T>(x: T): T }\nconst b = y as Foo;";
    expect(() => findTypeAssertions("sample.tsx", source)).toThrow(
      /sample\.tsx:1:15/,
    );
  });

  test("does not treat a generic function type in a variable annotation as JSX", () => {
    const source = "const f: <T>(v: T) => T = (v) => v;\nconst b = y as Foo;";
    expect(lines(findTypeAssertions("sample.tsx", source))).toEqual([2]);
  });

  test("does not treat a comparison after a non-null assertion as JSX", () => {
    const source = "const ok = x! < y;\nconst b = y as Foo;";
    expect(lines(findTypeAssertions("sample.tsx", source))).toEqual([2]);
  });

  test("does not treat a comparison after a keyword-named property as JSX", () => {
    const source = "const ok = r.from < r.to;\nconst b = y as Foo;";
    expect(lines(findTypeAssertions("sample.tsx", source))).toEqual([2]);
  });

  test("does not treat a comparison after a reserved-word property as JSX", () => {
    const source = "const ok = a.default < b;\nconst b = y as Foo;";
    expect(lines(findTypeAssertions("sample.tsx", source))).toEqual([2]);
  });

  test("does not treat a comparison after an optional-chained keyword property as JSX", () => {
    const source = "const ok = a?.type < b;\nconst b = y as Foo;";
    expect(lines(findTypeAssertions("sample.tsx", source))).toEqual([2]);
  });

  test("still reads JSX in the branches of a conditional expression", () => {
    const source = "const a = c ? <A>as</A> : <B>as</B>;\nconst b = y as Foo;";
    expect(lines(findTypeAssertions("sample.tsx", source))).toEqual([2]);
  });

  test("still reads JSX whose text starts with a parenthesis", () => {
    const source = "const a = <b>(as note)</b>;\nconst b = y as Foo;";
    expect(lines(findTypeAssertions("sample.tsx", source))).toEqual([2]);
  });

  test("reports an error when a JSX element is still open at the end of the file", () => {
    expect(() =>
      findTypeAssertions("sample.tsx", "const z = 1;\nconst a = <div>as"),
    ).toThrow(/sample\.tsx:2:11/);
  });

  test("ignores `as` in JSX text, attribute strings, and attribute names", () => {
    const source = [
      "const a = (",
      '  <Link as="a" title="treat it as data" data-as-of="x">',
      "    Read this as plain text, don't worry / about it",
      "    <>nested as text</>",
      "  </Link>",
      ");",
      "const b = 1;",
    ].join("\n");
    expect(findTypeAssertions("sample.tsx", source)).toHaveLength(0);
  });

  test("resumes ordinary checks after a JSX element ends", () => {
    const source = [
      "const a = <div>as text</div>;",
      "const b = <br />;",
      "const c = y as Foo;",
    ].join("\n");
    expect(lines(findTypeAssertions("sample.tsx", source))).toEqual([3]);
  });

  test("tracks nested elements and expressions", () => {
    const source = [
      "const a = (",
      "  <ul>",
      "    {items.map((item) => (",
      "      <li key={item.id}>{item.label} as text</li>",
      "    ))}",
      "    <li>{flag ? <b>yes</b> : `as ${n}`}</li>",
      "  </ul>",
      ");",
      "const c = y as Foo;",
    ].join("\n");
    expect(lines(findTypeAssertions("sample.tsx", source))).toEqual([9]);
  });

  test("treats generic arrow functions as code, not JSX", () => {
    const source = [
      "const id = <T,>(v: T) => v as Foo;",
      "const pick = <T extends object>(v: T) => v;",
    ].join("\n");
    expect(lines(findTypeAssertions("sample.tsx", source))).toEqual([1]);
  });

  test("does not treat a less-than comparison as JSX", () => {
    const source = "const ok = a < b;\nconst c = y as Foo;";
    expect(lines(findTypeAssertions("sample.tsx", source))).toEqual([2]);
  });

  test("allows an assertion inside a type guard in a .tsx file", () => {
    const source = [
      "function isFoo(v: unknown): v is Foo {",
      '  return (v as Foo).kind === "foo";',
      "}",
    ].join("\n");
    expect(findTypeAssertions("sample.tsx", source)).toHaveLength(0);
  });
});
