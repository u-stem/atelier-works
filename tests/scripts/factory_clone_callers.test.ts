import { describe, expect, test } from "bun:test";

// Factory自身のcloneは、照合を通る`ensureVerifiedFactoryClone`か`openFactoryClone`で用意する。
// `ensureFactoryClone`を直接使うと、`factory_repo_id`を照合せずに取得してしまう。
// importの文字列を照合するので、動的importや再エクスポートは見つけられない。

const ALLOWED = new Set([
  "f/factory/lib/workspace.ts",
  "f/factory/lib/factory_repo_gate.ts",
]);

/** `openFactoryClone(config,`で、Factory自身のcloneを用意する呼び出し元。 */
const OPEN_CLONE_CALLERS = [
  "f/factory/poll_issues.ts",
  "f/factory/steps/audit_prepare.ts",
  "f/factory/steps/implement_prepare.ts",
  "f/factory/steps/pipeline_generate.ts",
  "f/factory/steps/pipeline_prepare.ts",
  "f/factory/steps/pr_fix_prepare.ts",
  "f/factory/steps/pr_review_prepare.ts",
];

const WORKSPACE_MODULE = String.raw`"[^"]*\/workspace(?:\.ts)?"`;
/** `workspace.ts`から`ensureFactoryClone`を取り込む名前付きimport（別名を含む）。 */
const NAMED_IMPORT = new RegExp(
  String.raw`import\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{[^}]*\bensureFactoryClone\b[^}]*\}\s*from\s*${WORKSPACE_MODULE}`,
);
/** `workspace.ts`の名前空間import。そこから`ensureFactoryClone`を呼べてしまう。 */
const NAMESPACE_IMPORT = new RegExp(
  String.raw`import\s+\*\s+as\s+[\w$]+\s+from\s*${WORKSPACE_MODULE}`,
);

async function scriptSources(): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  for await (const path of new Bun.Glob("f/factory/**/*.ts").scan(".")) {
    const text = (await Bun.file(path).text())
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\s\/\/.*$/gm, "");
    out.push({ path, text });
  }
  return out;
}

describe("Factory clone callers", () => {
  test("only the allowed modules import ensureFactoryClone", async () => {
    const importers = (await scriptSources())
      .filter(
        ({ path, text }) =>
          !ALLOWED.has(path) &&
          (NAMED_IMPORT.test(text) || NAMESPACE_IMPORT.test(text)),
      )
      .map(({ path }) => path);

    expect(importers).toEqual([]);
  });

  test("the import pattern finds an aliased import", () => {
    const text =
      'import { ensureFactoryClone as clone } from "../lib/workspace.ts";';

    expect(NAMED_IMPORT.test(text)).toBe(true);
  });

  test("the import pattern finds a namespace import", () => {
    const text = 'import * as ws from "./lib/workspace.ts";';

    expect(NAMESPACE_IMPORT.test(text)).toBe(true);
  });

  test("every caller prepares the clone through openFactoryClone", async () => {
    const sources = await scriptSources();
    const missing = OPEN_CLONE_CALLERS.filter(
      (path) =>
        !/\bopenFactoryClone\(config,/.test(
          sources.find((source) => source.path === path)?.text ?? "",
        ),
    );

    expect(missing).toEqual([]);
  });
});
