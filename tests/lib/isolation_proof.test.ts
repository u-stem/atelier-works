// 隔離の合格の証拠の型を固定する。
// 保護パスに置く。証拠を偽造できる変更や、関門以外が証拠を作れる変更が、このテストを書き換えて通らないようにするため。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertIsolationProof,
  IsolationProofError,
  mintIsolationProof,
} from "../../f/factory/lib/isolation_proof.ts";

describe("assertIsolationProof", () => {
  test("accepts a proof that mintIsolationProof made", () => {
    expect(() => assertIsolationProof(mintIsolationProof())).not.toThrow();
  });

  test("accepts the same proof again", () => {
    const proof = mintIsolationProof();
    assertIsolationProof(proof);
    expect(() => assertIsolationProof(proof)).not.toThrow();
  });

  const FORGERIES: readonly [string, () => unknown][] = [
    ["undefined", () => undefined],
    ["null", () => null],
    ["a string", () => "isolation-proof"],
    ["a function", () => () => undefined],
    ["an empty object", () => ({})],
    [
      "an object with the shape of a proof",
      () => ({ brand: "isolation-proof" }),
    ],
    [
      "a proof that went through JSON",
      () => JSON.parse(JSON.stringify(mintIsolationProof())),
    ],
    [
      "a structured clone of a proof",
      () => structuredClone(mintIsolationProof()),
    ],
    [
      "an object with the prototype of a proof",
      () => Object.create(Object.getPrototypeOf(mintIsolationProof())),
    ],
    [
      "an instance made with the constructor of a proof",
      () => Reflect.construct(mintIsolationProof().constructor, []),
    ],
    [
      "a copy of the own properties of a proof",
      () => Object.assign(Object.create(null), mintIsolationProof()),
    ],
    ["a proxy of a proof", () => new Proxy(mintIsolationProof(), {})],
  ];

  test.each(FORGERIES)("rejects %s", (_name, make) => {
    expect(() => assertIsolationProof(make())).toThrow(IsolationProofError);
  });
});

// 証拠を作る関数と、証拠の型を持つモジュールは、本番では関門と調査の入口だけが参照する。
// 他のファイルが参照すると、測定に合格していなくても証拠を作れる。
// 文字列の照合は`Bun.Transpiler`でコメントを落としてから行う。
// 追えない形がある。識別子を連結して組み立てる動的な参照は数えられない。
describe("who refers to the proof", () => {
  const FACTORY_DIR = join(import.meta.dir, "../../f/factory");
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const DEFINING_FILE = "lib/isolation_proof.ts";
  const GATE_FILE = "lib/investigate_isolation_gate.ts";
  const ENTRY_FILE = "lib/investigate_claude.ts";
  const MINT = /(?<![\w$])mintIsolationProof(?![\w$])/g;
  const MODULE = /(?:^|\/)isolation_proof(?:\.ts)?$/;

  function mentionsMint(code: string): number {
    return [...code.matchAll(MINT)].length;
  }

  /** 名前空間の取り込み、再エクスポート、動的なimport、`require`の文字列の指定子も拾う。 */
  function importsModule(code: string): boolean {
    return transpiler
      .scanImports(code)
      .some((entry) => MODULE.test(entry.path));
  }

  function transpiled(path: string): string {
    return transpiler.transformSync(
      readFileSync(join(FACTORY_DIR, path), "utf8"),
    );
  }

  function productionSources(): string[] {
    return [...new Bun.Glob("**/*.ts").scanSync(FACTORY_DIR)]
      .filter((path) => !path.endsWith(".test.ts"))
      .sort();
  }

  test("is imported by the gate and the investigate entry only", () => {
    const found = productionSources().filter((path) =>
      importsModule(transpiled(path)),
    );
    expect(found).toEqual([ENTRY_FILE, GATE_FILE].sort());
  });

  test("has mintIsolationProof named by no production file other than the gate and the defining file", () => {
    const found = productionSources().filter(
      (path) =>
        path !== DEFINING_FILE &&
        path !== GATE_FILE &&
        mentionsMint(transpiled(path)) > 0,
    );
    expect(found).toEqual([]);
  });

  test("has mintIsolationProof named in the gate by its import and its call", () => {
    expect(mentionsMint(transpiled(GATE_FILE))).toBe(2);
  });

  test("has mintIsolationProof named in the defining file by its definition only", () => {
    expect(mentionsMint(transpiled(DEFINING_FILE))).toBe(1);
  });

  test("counts a namespace import", () => {
    expect(importsModule('import * as p from "./isolation_proof.ts"; p;')).toBe(
      true,
    );
  });

  test("counts a re-export", () => {
    expect(importsModule('export * from "./isolation_proof";')).toBe(true);
  });

  test("counts a named re-export", () => {
    expect(
      importsModule(
        'export { mintIsolationProof } from "./isolation_proof.ts";',
      ),
    ).toBe(true);
  });

  test("counts a dynamic import with a string", () => {
    expect(importsModule('await import("./isolation_proof.ts");')).toBe(true);
  });

  test("counts a require call with a string", () => {
    expect(importsModule('require("./isolation_proof.ts");')).toBe(true);
  });

  test("does not count a module with a longer name", () => {
    expect(importsModule('import "./not_isolation_proof_x.ts";')).toBe(false);
  });

  test("counts an import of mintIsolationProof under another name", () => {
    const code = transpiler.transformSync(
      'import { mintIsolationProof as mint } from "./isolation_proof.ts"; mint();',
    );
    expect(mentionsMint(code)).toBe(1);
  });

  test("does not count a longer name", () => {
    const code = transpiler.transformSync("const x = mintIsolationProofX;");
    expect(mentionsMint(code)).toBe(0);
  });
});
