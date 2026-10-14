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
