import { describe, expect, test } from "bun:test";

// Factory自身のcloneは、照合を通る`ensureVerifiedFactoryClone`か`openFactoryClone`で用意する。
// `ensureFactoryClone`を直接呼ぶと、`factory_repo_id`を照合せずに取得してしまう。
// ソースの文字列照合なので、別名のimportなどは見つけられない。

const ALLOWED = new Set([
  "f/factory/lib/workspace.ts",
  "f/factory/lib/factory_repo_gate.ts",
]);

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
  test("only the verified wrapper calls ensureFactoryClone", async () => {
    const callers = (await scriptSources())
      .filter(
        ({ path, text }) =>
          !ALLOWED.has(path) && /(?<![.\w])ensureFactoryClone\(/.test(text),
      )
      .map(({ path }) => path);

    expect(callers).toEqual([]);
  });

  test("pr_review_prepare reaches the clone through openFactoryClone", async () => {
    const source = (await scriptSources()).find(({ path }) =>
      path.endsWith("steps/pr_review_prepare.ts"),
    );

    expect(source?.text).toMatch(/openFactoryClone\(config,/);
  });
});
