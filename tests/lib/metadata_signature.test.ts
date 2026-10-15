import { describe, expect, test } from "bun:test";
import {
  diffSourceShape,
  readSourceShape,
} from "../../f/factory/lib/metadata_signature.ts";
import { readRepoFiles } from "./metadata_repo_tree.ts";

function mainOf(code: string): string | null | "unparsable" {
  const result = readSourceShape(code);
  return result.ok ? result.shape.main : "unparsable";
}

function declarationsOf(code: string): readonly string[] | "unparsable" {
  const result = readSourceShape(code);
  return result.ok ? result.shape.declarations : "unparsable";
}

function difference(base: string, head: string): string {
  const result = diffSourceShape(base, head);
  return result.ok ? (result.change ?? "same") : result.reason;
}

describe("readSourceShape main", () => {
  test("reads the exported main with its parameters and return type", () => {
    expect(
      mainOf(
        "export async function main(a: string, b = 1): Promise<number> { return b; }",
      ),
    ).toBe(
      "export async function main ( a : string , b = 1 ) : Promise < number >",
    );
  });

  test("ignores whitespace and comments in the signature", () => {
    const spread = `export function main(
      // the first argument
      a: /* the type */ string
    ) {
      return 1;
    }`;
    expect(mainOf(spread)).toBe("export function main ( a : string )");
  });

  test("ends the return type at the body when the type is an object type", () => {
    expect(
      mainOf("export function main(): { a: string } { return { a: 'x' }; }"),
    ).toBe("export function main ( ) : { a : string }");
  });

  test("ends the return type at the body when the type has a generic object type", () => {
    expect(
      mainOf("export function main(): Promise<{ a: string }> { return x; }"),
    ).toBe("export function main ( ) : Promise < { a : string } >");
  });

  test("keeps a closing parenthesis inside a string default value", () => {
    expect(mainOf("export function main(a = ')') { return a; }")).toBe(
      "export function main ( a = ')' )",
    );
  });

  test("keeps a closing parenthesis inside a template literal default value", () => {
    const template = ["`)", "$", "{')'}`"].join("");
    expect(mainOf(`export function main(a = ${template}) { return a; }`)).toBe(
      `export function main ( a = ${template} )`,
    );
  });

  test("keeps a closing parenthesis inside a regular expression default value", () => {
    expect(mainOf("export function main(a = /\\)[)]/) { return a; }")).toBe(
      "export function main ( a = /\\)[)]/ )",
    );
  });

  test("ignores a closing parenthesis inside a comment", () => {
    expect(mainOf("export function main(a /* ) */) { return a; }")).toBe(
      "export function main ( a )",
    );
  });

  test("reads generic parameters of main", () => {
    expect(mainOf("export function main<T>(a: T) { return a; }")).toBe(
      "export function main < T > ( a : T )",
    );
  });

  test("returns null for a file without main", () => {
    expect(mainOf("export const x = 1;\n")).toBeNull();
  });

  test("gives up when main is exported as a variable", () => {
    expect(mainOf("export const main = async (a: string) => a;\n")).toBe(
      "unparsable",
    );
  });

  test("gives up when main is a default export", () => {
    expect(
      mainOf("export default function main(a: string) { return a; }"),
    ).toBe("unparsable");
  });

  test("gives up when main is exported in a list", () => {
    expect(mainOf("function main(a: string) {}\nexport { main };\n")).toBe(
      "unparsable",
    );
  });

  test("ignores a local variable named main that is not exported", () => {
    expect(
      mainOf("const main = dirOf('x');\nexport const y = main;\n"),
    ).toBeNull();
  });

  test("gives up when two main functions are exported", () => {
    expect(
      mainOf("export function main(a) {}\nexport function main(a, b) {}\n"),
    ).toBe("unparsable");
  });

  test("gives up on an overload signature without a body", () => {
    expect(mainOf("export function main(a: string): void;\n")).toBe(
      "unparsable",
    );
  });

  test("gives up on unbalanced parentheses", () => {
    expect(mainOf("export function main(a: string {\n")).toBe("unparsable");
  });

  test("gives up on an unterminated string", () => {
    expect(mainOf("const a = 'abc\nexport function main() {}\n")).toBe(
      "unparsable",
    );
  });

  test("gives up on an unterminated block comment", () => {
    expect(mainOf("/* open\nexport function main() {}\n")).toBe("unparsable");
  });

  test("gives up on an unterminated template literal", () => {
    expect(mainOf("const a = `abc\nexport function main() {}\n")).toBe(
      "unparsable",
    );
  });

  test("gives up on a slash after a closing brace", () => {
    expect(mainOf("function f() {}\n/ 2;\nexport function main() {}\n")).toBe(
      "unparsable",
    );
  });

  test("gives up on a regular expression that is not closed on its line", () => {
    expect(mainOf("const r = /abc\nexport function main() {}\n")).toBe(
      "unparsable",
    );
  });

  test("treats a slash after a closing parenthesis as division", () => {
    expect(
      mainOf("const a = (1 + 2) / 3;\nexport function main(b: number) {}\n"),
    ).toBe("export function main ( b : number )");
  });

  test("ignores a main that appears only in a comment or a string", () => {
    expect(
      mainOf(
        "// export function main(a) {}\nconst s = 'export function main()';\n",
      ),
    ).toBeNull();
  });
});

describe("readSourceShape exported names across line breaks", () => {
  test("gives up when main is exported as a variable after a line break", () => {
    expect(mainOf("export const\n  main = async (a: string) => a;\n")).toBe(
      "unparsable",
    );
  });

  test("gives up when main is a default export after a line break", () => {
    expect(
      mainOf(
        "export default\n  async function main(a: string) { return a; }\n",
      ),
    ).toBe("unparsable");
  });

  test("reads an identifier with a zero width joiner as one word", () => {
    const joiner = String.fromCharCode(0x200d);
    expect(mainOf(`export function main(a${joiner}b) {}`)).toBe(
      `export function main ( a${joiner}b )`,
    );
  });
});

describe("readSourceShape bounds", () => {
  test("gives up on deeply nested template literals without throwing", () => {
    const nested = "`${".repeat(350_000);
    expect(readSourceShape(nested).ok).toBe(false);
  });

  test("gives up on nested template literals deeper than the limit", () => {
    const nested = `${"`${".repeat(300)}1${"}`".repeat(300)}`;
    expect(readSourceShape(nested).ok).toBe(false);
  });

  test("reads template literals nested within the limit", () => {
    const nested = `${"`${".repeat(20)}1${"}`".repeat(20)}`;
    expect(readSourceShape(`const a = ${nested};\n`).ok).toBe(true);
  });
});

describe("readSourceShape functions that are not exported", () => {
  test("gives up on a main function that is not exported", () => {
    expect(mainOf("function main(x: string) {}\n")).toBe("unparsable");
  });

  test("gives up on an async main function that is not exported", () => {
    expect(mainOf("async function main(x: string) {}\n")).toBe("unparsable");
  });

  test("gives up on a main function that is not exported next to an exported one", () => {
    expect(
      mainOf(
        "function main(x: string) {}\nexport function main(y: number) {}\n",
      ),
    ).toBe("unparsable");
  });

  test("gives up on a preprocessor function that is not exported", () => {
    expect(
      readSourceShape("function preprocessor(event: string) {}\n").ok,
    ).toBe(false);
  });

  test("does not mind a function named main inside another function", () => {
    expect(mainOf("function outer() {\n  function main() {}\n}\n")).toBeNull();
  });
});

describe("readSourceShape and the extent of declarations", () => {
  test("gives up on many type aliases that are not closed within the work limit", () => {
    const code = "type A = 1\n{}".repeat(80_000);
    expect(readSourceShape(code).ok).toBe(false);
  });

  test("gives up on many type aliases quickly", () => {
    const code = "type A = 1\n{}".repeat(80_000);
    const started = performance.now();
    readSourceShape(code);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test("reads many declarations that each end at once", () => {
    const code = "type A = 1;\n".repeat(20_000);
    expect(readSourceShape(code).ok).toBe(true);
  });

  test("keeps the whole class when its heritage has an object type", () => {
    const code =
      "export class A extends Base<{ a: string }> { m() { return 1; } }\nexport function main() {}\n";
    expect(declarationsOf(code)).toEqual([
      "export class A extends Base < { a : string } > { m ( ) { return 1 ; } }",
    ]);
  });

  test("detects a changed method body of a class whose heritage has an object type", () => {
    const base =
      "export class A extends Base<{ a: string }> { m() { return 1; } }\nexport function main() {}\n";
    expect(difference(base, base.replace("return 1", "return 2"))).toBe(
      "declaration_changed",
    );
  });

  test("keeps the whole interface when its heritage has an object type", () => {
    const code =
      "export interface I extends Base<{ a: string }> { b: number }\n";
    expect(declarationsOf(code)).toEqual([
      "export interface I extends Base < { a : string } > { b : number }",
    ]);
  });

  test("keeps a type alias whose next line starts with an abstract constructor type", () => {
    const code = "type A =\n  abstract new () => string\ntype B = number\n";
    expect(declarationsOf(code)).toEqual([
      "type A = abstract new ( ) => string",
      "type B = number",
    ]);
  });

  test("keeps a type alias whose next line starts with a type import", () => {
    const code = 'type A =\n  import("x").T\ntype B = number\n';
    expect(declarationsOf(code)).toEqual([
      'type A = import ( "x" ) . T',
      "type B = number",
    ]);
  });

  test("still ends a type alias at an abstract class", () => {
    const code = "type A = string\nabstract class C { m() {} }\n";
    expect(declarationsOf(code)).toEqual([
      "abstract class C { m ( ) { } }",
      "type A = string",
    ]);
  });

  test("gives up on a class whose body cannot be found", () => {
    expect(
      readSourceShape("export class A extends B<{ a: string }>;\n").ok,
    ).toBe(false);
  });
});

describe("readSourceShape generator functions", () => {
  test("gives up on a main generator function that is not exported", () => {
    expect(mainOf("function* main() {}\n")).toBe("unparsable");
  });

  test("gives up on an async main generator function that is not exported", () => {
    expect(mainOf("async function* main() {}\n")).toBe("unparsable");
  });

  test("gives up on an exported main generator function", () => {
    expect(mainOf("export function* main() {}\n")).toBe("unparsable");
  });

  test("gives up on a preprocessor generator function that is not exported", () => {
    expect(readSourceShape("function* preprocessor() {}\n").ok).toBe(false);
  });
});

describe("readSourceShape and a long annotation line", () => {
  test("reads a line of spaces of 1MiB quickly", () => {
    const code = `//${" ".repeat(1_000_000)}a${" ".repeat(40_000)}b\n`;
    const started = performance.now();
    readSourceShape(code);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe("readSourceShape preprocessor", () => {
  test("reads the exported preprocessor signature", () => {
    const result = readSourceShape(
      "export async function preprocessor(event: { x: string }) { return event; }",
    );
    expect(result.ok && result.shape.preprocessor).toBe(
      "export async function preprocessor ( event : { x : string } )",
    );
  });

  test("returns null when there is no preprocessor", () => {
    const result = readSourceShape("export function main() {}");
    expect(result.ok && result.shape.preprocessor).toBeNull();
  });

  test("gives up when the preprocessor is exported as a variable", () => {
    expect(
      readSourceShape("export const preprocessor = async (e: string) => e;").ok,
    ).toBe(false);
  });
});

describe("readSourceShape annotations", () => {
  const annotations = (code: string) => {
    const result = readSourceShape(code);
    return result.ok ? result.shape.annotations : "unparsable";
  };

  test("collects comment lines that look like Windmill annotations", () => {
    expect(
      annotations(
        "//npm\n// package_json: x\n//extra_requirements: y\nexport function main() {}\n",
      ),
    ).toEqual(["// package_json: x", "//extra_requirements: y", "//npm"]);
  });

  test("does not collect an ordinary sentence in a comment", () => {
    expect(annotations("// this is a comment\nexport const x = 1;\n")).toEqual(
      [],
    );
  });

  test("collects the comment lines that follow an annotation ending with a colon", () => {
    expect(
      annotations(
        '//extra_package_json:\n// {"dependencies": {"left-pad": "1.3.0"}}\n// more lines\nexport const x = 1;\n',
      ),
    ).toEqual([
      "// more lines",
      '// {"dependencies": {"left-pad": "1.3.0"}}',
      "//extra_package_json:",
    ]);
  });

  test("collects the comment lines that follow an annotation that has a value", () => {
    expect(
      annotations(
        '// package_json: {"dependencies": {}}\n// continued\nexport const x = 1;\n',
      ),
    ).toEqual(["// continued", '// package_json: {"dependencies": {}}']);
  });

  test("does not collect the comment lines that follow an annotation without a value", () => {
    expect(
      annotations("//npm\n// an ordinary remark here\nexport const x = 1;\n"),
    ).toEqual(["//npm"]);
  });

  test("stops collecting at the first line that is not a comment", () => {
    expect(
      annotations(
        "//extra_requirements:\n// numpy\nexport const x = 1;\n// after code\n",
      ),
    ).toEqual(["// numpy", "//extra_requirements:"]);
  });

  test("collects an annotation-like line inside a template literal on the safe side", () => {
    const code = ["export const t = `", "//npm", "`;", ""].join("\n");
    expect(annotations(code)).toEqual(["//npm"]);
  });

  test("collects an annotation below the first lines", () => {
    expect(annotations("export const x = 1;\n\n//nobundling\n")).toEqual([
      "//nobundling",
    ]);
  });
});

describe("readSourceShape declarations", () => {
  test("collects top-level type, interface, enum and class declarations", () => {
    expect(
      declarationsOf(
        [
          "type A = { a: string };",
          "export interface B { b: number }",
          "enum C { X, Y }",
          "export class D { d = 1 }",
        ].join("\n"),
      ),
    ).toEqual([
      "enum C { X , Y }",
      "export class D { d = 1 }",
      "export interface B { b : number }",
      "type A = { a : string } ;",
    ]);
  });

  test("ends a type alias without a semicolon at the next statement", () => {
    expect(
      declarationsOf("type A =\n  | 'a'\n  | 'b'\nconst x = 1;\n"),
    ).toEqual(["type A = | 'a' | 'b'"]);
  });

  test("does not collect a type declared inside a function", () => {
    expect(
      declarationsOf("function f() {\n  type Inner = string;\n}\n"),
    ).toEqual([]);
  });

  test("does not mistake a variable named type for a declaration", () => {
    expect(declarationsOf("const type = 1;\nlet x = type;\n")).toEqual([]);
  });
});

describe("diffSourceShape", () => {
  const base =
    "type A = { a: string };\nexport function main(a: A) { return 1; }\n";

  test("is the same when only the body changes", () => {
    expect(difference(base, base.replace("return 1", "return 2"))).toBe("same");
  });

  test("detects a changed parameter type", () => {
    expect(difference(base, base.replace("a: A", "a: A, b: number"))).toBe(
      "main_changed",
    );
  });

  test("detects a changed return type", () => {
    expect(difference(base, base.replace("(a: A)", "(a: A): number"))).toBe(
      "main_changed",
    );
  });

  test("detects a changed type declaration", () => {
    expect(difference(base, base.replace("a: string", "a: number"))).toBe(
      "declaration_changed",
    );
  });

  test("accepts a changed type declaration in a file without main and preprocessor", () => {
    expect(
      difference(
        "export type Opts = { a: string };\nexport class K { m() { return 1; } }\n",
        "export type Opts = { a: string; b: number };\nexport class K { m() { return 2; } }\n",
      ),
    ).toBe("same");
  });

  test("detects a changed type declaration in a file with only a preprocessor", () => {
    const withPre = (field: string) =>
      `type Local = { ${field} };\nexport async function preprocessor(event: string) { return event; }\n`;
    expect(difference(withPre("a: string"), withPre("a: number"))).toBe(
      "declaration_changed",
    );
  });

  test("detects an added main", () => {
    expect(difference("export const x = 1;\n", base)).toBe(
      "main_presence_changed",
    );
  });

  test("detects a removed main", () => {
    expect(difference(base, "export const x = 1;\n")).toBe(
      "main_presence_changed",
    );
  });

  test("detects an added npm annotation", () => {
    expect(difference(base, `//npm\n${base}`)).toBe("annotation_changed");
  });

  test("detects an added native annotation", () => {
    expect(difference(base, `//native\n${base}`)).toBe("annotation_changed");
  });

  test("detects an added package_json annotation", () => {
    expect(difference(base, `// package_json: x\n${base}`)).toBe(
      "annotation_changed",
    );
  });

  test("detects a removed annotation", () => {
    expect(difference(`//npm\n${base}`, base)).toBe("annotation_changed");
  });

  test("accepts a changed ordinary comment", () => {
    expect(
      difference(`// first remark\n${base}`, `// second remark\n${base}`),
    ).toBe("same");
  });

  test("detects an added preprocessor", () => {
    expect(
      difference(
        base,
        `${base}export async function preprocessor(event: string) { return event; }\n`,
      ),
    ).toBe("preprocessor_changed");
  });

  test("detects a changed preprocessor signature", () => {
    const withPre = (arg: string) =>
      `${base}export async function preprocessor(${arg}) { return 1; }\n`;
    expect(difference(withPre("event: string"), withPre("event: number"))).toBe(
      "preprocessor_changed",
    );
  });

  test("accepts a changed preprocessor body", () => {
    const withPre = (body: string) =>
      `${base}export async function preprocessor(event: string) { return ${body}; }\n`;
    expect(difference(withPre("1"), withPre("2"))).toBe("same");
  });

  test("reports unparsable when either side cannot be read", () => {
    expect(difference(base, "const a = 'open\n")).toBe("unparsable");
  });
});

describe("repository sources", () => {
  const sources = [...readRepoFiles()].filter(
    ([path]) => path.startsWith("f/") && path.endsWith(".ts"),
  );

  test("every script under f/ can be read", () => {
    const unreadable = sources
      .filter(
        ([, bytes]) => !readSourceShape(new TextDecoder().decode(bytes)).ok,
      )
      .map(([path]) => path);
    expect(unreadable).toEqual([]);
  });

  test("every script that declares main at a line start has a main signature", () => {
    const missing = sources
      .filter(([, bytes]) =>
        /^export (?:async )?function main\b/m.test(
          new TextDecoder().decode(bytes),
        ),
      )
      .filter(([, bytes]) => {
        const result = readSourceShape(new TextDecoder().decode(bytes));
        return !result.ok || result.shape.main === null;
      })
      .map(([path]) => path);
    expect(missing).toEqual([]);
  });
});
