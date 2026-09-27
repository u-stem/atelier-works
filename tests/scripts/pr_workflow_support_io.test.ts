// Tests for f/factory/steps/pr_workflow_support.ts's small additive I/O
// helpers not exposed by lib/github.ts, lib/db.ts, or lib/workspace.ts — see
// that file's header comment for why each exists here. getBranchProtected /
// postIssueComment / setHeadSha / fetchPrHeadRef / readGitShowFile / addLabels
// used to be tested here too, but team-lead fix round 2 items a and the
// re-gate note removed this file's local copies of those six once
// lib/github.ts, lib/db.ts, and lib/workspace.ts promoted the same functions
// (same signatures) — they're covered by tests/lib/github.test.ts,
// tests/lib/db.test.ts, and tests/lib/workspace.test.ts now instead.
// removeTerminalLabels was removed by the 2026-09-27 PR label cleanup (no
// more state/wip labels to clear on a terminal transition).

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
