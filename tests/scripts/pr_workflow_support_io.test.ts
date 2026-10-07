// `pr_workflow_support.ts`の小さな入出力補助のテスト。

import { describe, expect, test } from "bun:test";
import { readWorktreeFileIfExists } from "../../f/factory/steps/pr_workflow_support.ts";

describe("readWorktreeFileIfExists", () => {
  test("returns the content when the read succeeds", async () => {
    const content = await readWorktreeFileIfExists("/work/a.txt", () =>
      Promise.resolve("hi"),
    );
    expect(content).toBe("hi");
  });

  test("returns null when the read throws (file missing)", async () => {
    const content = await readWorktreeFileIfExists("/work/missing.txt", () =>
      Promise.reject(new Error("ENOENT")),
    );
    expect(content).toBeNull();
  });
});
