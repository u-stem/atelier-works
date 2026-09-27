// Test for poll_issues.ts's readRepoHeadSha (`git rev-parse HEAD` for the
// self clone, used by checkDeployedSha). Relocated here from
// f/factory/lib/poll_support.ts, which is pure-decision-functions-only —
// see poll_support.ts's header comment.

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
