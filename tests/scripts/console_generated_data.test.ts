// Consoleのバンドルに取り込む生成データが、docs-genの書くものだけであることを固定する。
// docs-genが書かなくなったデータが残ると、`docs:gen --check`に見張られないまま古くなる。
// 読む側が無いデータが残ると、バンドルの大きさだけを増やす。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { FLOWS_FILE } from "../../scripts/docs-gen.ts";

const ROOT = join(import.meta.dir, "../..");
const GENERATED_DIR = join(ROOT, "console/src/generated");
const SOURCE_DIR = join(ROOT, "console/src");

/** `console/src`の下のソースが`generated/`から取り込むファイル名の集合。 */
function importedGeneratedFiles(): string[] {
  const found = new Set<string>();
  for (const file of new Bun.Glob("**/*.{ts,tsx}").scanSync(SOURCE_DIR)) {
    const text = readFileSync(join(SOURCE_DIR, file), "utf8");
    for (const match of text.matchAll(/from\s+"[^"]*\/generated\/([^"]+)"/g)) {
      found.add(match[1] ?? "");
    }
  }
  return [...found].sort();
}

describe("the generated data of the console", () => {
  test("holds only the files that docs-gen writes", () => {
    expect(readdirSync(GENERATED_DIR).sort()).toEqual([basename(FLOWS_FILE)]);
  });

  test("is read by the sources that import it, and by nothing else", () => {
    expect(importedGeneratedFiles()).toEqual([basename(FLOWS_FILE)]);
  });
});
