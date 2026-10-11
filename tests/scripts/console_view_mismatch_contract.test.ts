import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Consoleは、この文でバックエンドとの版のずれを見分ける。
// 文を変えるときは、`console/src/lib/queryFailureView.ts`の判定も同時に変える。
const SCRIPT_URL = new URL(
  "../../f/factory/steps/console_query.ts",
  import.meta.url,
);

describe("console_query view mismatch message", () => {
  test("keeps the phrase the console matches on", () => {
    const source = readFileSync(SCRIPT_URL, "utf8");
    expect(source).toContain('"view" must be one of');
  });

  test("keeps the requested view at the end of the message", () => {
    const source = readFileSync(SCRIPT_URL, "utf8");
    expect(source).toMatch(/\(got \$\{JSON\.stringify\(view\)\}\)/);
  });
});
