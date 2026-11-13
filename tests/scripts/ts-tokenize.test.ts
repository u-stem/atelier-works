import { describe, expect, test } from "bun:test";
import { SyntaxKind } from "typescript/unstable/ast";
import { type TokenizeOptions, tokenize } from "../../scripts/ts-tokenize.ts";

// `as`のキーワードとして読んだトークンの行番号(1始まり)を返す。
// 文字列、テンプレート、正規表現、JSXの本文の中の"as"は、読み分けが正しければ含まれない。
function asKeywordLines(
  source: string,
  options: TokenizeOptions = {},
): number[] {
  return tokenize(source, options)
    .filter((token) => token.kind === SyntaxKind.AsKeyword)
    .map((token) => source.slice(0, token.start).split("\n").length);
}

function tokenTexts(source: string): string[] {
  return tokenize(source).map((token) => token.text);
}

// 投げられた値を返す。投げなければ`undefined`を返す。
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

const JSX = { jsx: true };

// 通常の文字列に置換の記号を書くとlintの警告が出るため、組み立てて使う。
const OPEN = "$" + "{";

describe("tokenize", () => {
  test('does not read the word "as" inside a template literal substitution\'s trailing text as a keyword', () => {
    const source = `const x = \`${OPEN}label} treat it as data\`;`;
    expect(asKeywordLines(source)).toEqual([]);
  });

  test("still reads an `as` keyword that follows a template literal substitution", () => {
    const source = `const x = \`${OPEN}label}\`; const y = value as Foo;`;
    expect(asKeywordLines(source)).toEqual([1]);
  });

  test("does not lose track of nested braces inside a template literal substitution", () => {
    const source = `const x = \`${OPEN} { a: 1 } } treat it as data\`;`;
    expect(asKeywordLines(source)).toEqual([]);
  });

  test("reads a regular expression literal as one token (`#(` would stall the scanner)", () => {
    expect(tokenTexts("const pattern = /close[sd]?\\s*#(\\d+)/gi;")).toContain(
      "/close[sd]?\\s*#(\\d+)/gi",
    );
  });

  test('does not read the word "as" inside a regular expression literal as a keyword', () => {
    expect(
      asKeywordLines("const pattern = / as /; const other = value;"),
    ).toEqual([]);
  });

  test("still reads an `as` keyword that follows a division", () => {
    expect(asKeywordLines("const x = (total / count) as Foo;")).toEqual([1]);
  });

  test("throws a ScannerStallError at the stalled offset instead of looping", () => {
    expect(thrownBy(() => tokenize("#("))).toMatchObject({
      name: "ScannerStallError",
      position: 0,
    });
  });

  test("reads `>>` closing nested generics as two tokens", () => {
    expect(tokenTexts("const a: Array<Array<Foo>> = [];")).toEqual([
      "const",
      "a",
      ":",
      "Array",
      "<",
      "Array",
      "<",
      "Foo",
      ">",
      ">",
      "=",
      "[",
      "]",
      ";",
    ]);
  });

  test("treats a slash after a keyword-named property as division, not a regular expression", () => {
    const source = "const y = r.type / 2; const t = '/'; const q = z as Foo;";
    expect(asKeywordLines(source)).toEqual([1]);
  });

  test("treats a slash after a non-null assertion as division, not a regular expression", () => {
    const source = 'const r = x! / 2; const t = "/"; const b = y as Foo;';
    expect(asKeywordLines(source)).toEqual([1]);
  });
});

describe("tokenize with jsx", () => {
  test("reads an `as` keyword inside a JSX attribute expression", () => {
    const source = "const z = 1;\nconst a = <Foo value={x as Bar} />;";
    expect(asKeywordLines(source, JSX)).toEqual([2]);
  });

  test("reads an `as` keyword inside a JSX child expression", () => {
    const source = "const z = 1;\nconst a = <div>{(x as Bar).name}</div>;";
    expect(asKeywordLines(source, JSX)).toEqual([2]);
  });

  test("reads `>>` closing nested generics in a type annotation", () => {
    const source = "const a: Array<Array<Foo>> = [];\nconst b = y as Foo;";
    expect(asKeywordLines(source, JSX)).toEqual([2]);
  });

  test("reads `>>` closing nested type arguments of a JSX tag", () => {
    const source = "const a = <Foo<Array<string>> />;\nconst b = y as Foo;";
    expect(asKeywordLines(source, JSX)).toEqual([2]);
  });

  test("treats a generic arrow function with a default type parameter as code", () => {
    const source = "const g = <T = string>(v: T) => v;\nconst b = y as Foo;";
    expect(asKeywordLines(source, JSX)).toEqual([2]);
  });

  test("treats a generic arrow function with a const type parameter as code", () => {
    const source = "const g = <const T,>(v: T) => v;\nconst b = y as Foo;";
    expect(asKeywordLines(source, JSX)).toEqual([2]);
  });

  test("reads a JSX tag with type arguments", () => {
    const source = 'const a = <Foo<string> prop="x" />;\nconst b = y as Foo;';
    expect(asKeywordLines(source, JSX)).toEqual([2]);
  });

  test("does not treat a generic function type in a type alias as JSX", () => {
    const source = "type Fn = <T>(x: T) => T;\nconst b = y as Foo;";
    expect(asKeywordLines(source, JSX)).toEqual([2]);
  });

  test("does not treat a generic function type in an interface member as JSX", () => {
    const source = "interface I { m: <T>(x: T) => T }\nconst b = y as Foo;";
    expect(asKeywordLines(source, JSX)).toEqual([2]);
  });

  test("throws an UnclosedJsxError instead of silently skipping a generic call signature misread as JSX", () => {
    const source = "interface I { <T>(x: T): T }\nconst b = y as Foo;";
    expect(thrownBy(() => tokenize(source, JSX))).toMatchObject({
      name: "UnclosedJsxError",
      position: 14,
    });
  });

  test("does not treat a generic function type in a variable annotation as JSX", () => {
    const source = "const f: <T>(v: T) => T = (v) => v;\nconst b = y as Foo;";
    expect(asKeywordLines(source, JSX)).toEqual([2]);
  });

  test("does not treat a comparison after a non-null assertion as JSX", () => {
    const source = "const ok = x! < y;\nconst b = y as Foo;";
    expect(asKeywordLines(source, JSX)).toEqual([2]);
  });

  test("does not treat a comparison after a keyword-named property as JSX", () => {
    const source = "const ok = r.from < r.to;\nconst b = y as Foo;";
    expect(asKeywordLines(source, JSX)).toEqual([2]);
  });

  test("does not treat a comparison after a reserved-word property as JSX", () => {
    const source = "const ok = a.default < b;\nconst b = y as Foo;";
    expect(asKeywordLines(source, JSX)).toEqual([2]);
  });

  test("does not treat a comparison after an optional-chained keyword property as JSX", () => {
    const source = "const ok = a?.type < b;\nconst b = y as Foo;";
    expect(asKeywordLines(source, JSX)).toEqual([2]);
  });

  test("still reads JSX in the branches of a conditional expression", () => {
    const source = "const a = c ? <A>as</A> : <B>as</B>;\nconst b = y as Foo;";
    expect(asKeywordLines(source, JSX)).toEqual([2]);
  });

  test("still reads JSX whose text starts with a parenthesis", () => {
    const source = "const a = <b>(as note)</b>;\nconst b = y as Foo;";
    expect(asKeywordLines(source, JSX)).toEqual([2]);
  });

  test("throws an UnclosedJsxError at the element when it is still open at the end of the file", () => {
    const source = "const z = 1;\nconst a = <div>as";
    expect(thrownBy(() => tokenize(source, JSX))).toMatchObject({
      name: "UnclosedJsxError",
      position: 23,
    });
  });

  test("does not read `as` in JSX text, attribute strings, and attribute names as a keyword", () => {
    const source = [
      "const a = (",
      '  <Link as="a" title="treat it as data" data-as-of="x">',
      "    Read this as plain text, don't worry / about it",
      "    <>nested as text</>",
      "  </Link>",
      ");",
      "const b = 1;",
    ].join("\n");
    expect(asKeywordLines(source, JSX)).toEqual([]);
  });

  test("resumes reading code after a JSX element ends", () => {
    const source = [
      "const a = <div>as text</div>;",
      "const b = <br />;",
      "const c = y as Foo;",
    ].join("\n");
    expect(asKeywordLines(source, JSX)).toEqual([3]);
  });

  test("tracks nested elements and expressions", () => {
    const source = [
      "const a = (",
      "  <ul>",
      "    {items.map((item) => (",
      "      <li key={item.id}>{item.label} as text</li>",
      "    ))}",
      `    <li>{flag ? <b>yes</b> : \`as ${OPEN}n}\`}</li>`,
      "  </ul>",
      ");",
      "const c = y as Foo;",
    ].join("\n");
    expect(asKeywordLines(source, JSX)).toEqual([9]);
  });

  test("treats generic arrow functions as code, not JSX", () => {
    const source = [
      "const id = <T,>(v: T) => v as Foo;",
      "const pick = <T extends object>(v: T) => v;",
    ].join("\n");
    expect(asKeywordLines(source, JSX)).toEqual([1]);
  });

  test("does not treat a less-than comparison as JSX", () => {
    const source = "const ok = a < b;\nconst c = y as Foo;";
    expect(asKeywordLines(source, JSX)).toEqual([2]);
  });
});
