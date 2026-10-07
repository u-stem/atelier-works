// `poll_issues.ts`の`readRepoHeadSha`のテスト。
// self cloneで`git rev-parse HEAD`を実行し、`checkDeployedSha`が使う。

import { describe, expect, test } from "bun:test";
import { readRepoHeadSha } from "../../f/factory/poll_issues.ts";
import { createFakeCommandRunner, fail, ok } from "../lib/testSupport.ts";

describe("readRepoHeadSha", () => {
  test("returns the trimmed rev-parse output", async () => {
    const { run } = createFakeCommandRunner([ok("abc1234\n")]);
    const sha = await readRepoHeadSha(run, "/workspaces/factory/atelier-works");
    expect(sha).toBe("abc1234");
  });

  test("throws when git rev-parse fails", async () => {
    const { run } = createFakeCommandRunner([fail("not a git repository")]);
    await expect(
      readRepoHeadSha(run, "/workspaces/factory/atelier-works"),
    ).rejects.toThrow();
  });
});
