// Tests for f/factory/steps/pr_workflow_support.ts's small additive I/O
// helpers not exposed by lib/github.ts, lib/db.ts, or lib/workspace.ts — see
// that file's header comment for why each exists here. getBranchProtected /
// postIssueComment / setHeadSha / fetchPrHeadRef / readGitShowFile / addLabels
// used to be tested here too, but team-lead fix round 2 items a and the
// re-gate note removed this file's local copies of those six once
// lib/github.ts, lib/db.ts, and lib/workspace.ts promoted the same functions
// (same signatures) — they're covered by tests/lib/github.test.ts,
// tests/lib/db.test.ts, and tests/lib/workspace.test.ts now instead.

import { describe, expect, test } from "bun:test";
import type { LogFields, Logger } from "../../f/factory/lib/log.ts";
import {
  readWorktreeFileIfExists,
  removeTerminalLabels,
} from "../../f/factory/steps/pr_workflow_support.ts";
import {
  createFakeCommandRunner,
  fail,
  ghApiOk,
  ghApiStdout,
  ok,
} from "../lib/testSupport.ts";

function createFakeLogger(): {
  log: Logger;
  warnings: { message: string; fields?: LogFields }[];
} {
  const warnings: { message: string; fields?: LogFields }[] = [];
  const log: Logger = {
    info: () => {},
    warn: (message, fields) => {
      warnings.push(fields === undefined ? { message } : { message, fields });
    },
    error: () => {},
  };
  return { log, warnings };
}

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

describe("removeTerminalLabels", () => {
  test("removes every given label", async () => {
    const { run, calls } = createFakeCommandRunner([ghApiOk([]), ghApiOk([])]);
    const { log } = createFakeLogger();
    await removeTerminalLabels(
      { run, ghToken: "token" },
      "octo-owner",
      "atelier-works",
      7,
      ["factory:wip", "factory:fix"],
      log,
    );
    expect(calls).toHaveLength(2);
  });

  test("does not throw when a label is already absent (404)", async () => {
    const { run } = createFakeCommandRunner([
      ok(ghApiStdout(404, { message: "Not Found" })),
    ]);
    const { log } = createFakeLogger();
    await expect(
      removeTerminalLabels(
        { run, ghToken: "token" },
        "octo-owner",
        "atelier-works",
        7,
        ["factory:wip"],
        log,
      ),
    ).resolves.toBeUndefined();
  });

  test("swallows a genuine removal failure instead of throwing", async () => {
    const { run } = createFakeCommandRunner([fail("network error")]);
    const { log } = createFakeLogger();
    await expect(
      removeTerminalLabels(
        { run, ghToken: "token" },
        "octo-owner",
        "atelier-works",
        7,
        ["factory:wip"],
        log,
      ),
    ).resolves.toBeUndefined();
  });

  test("logs a warning when a removal fails", async () => {
    const { run } = createFakeCommandRunner([fail("network error")]);
    const { log, warnings } = createFakeLogger();
    await removeTerminalLabels(
      { run, ghToken: "token" },
      "octo-owner",
      "atelier-works",
      7,
      ["factory:wip"],
      log,
    );
    expect(warnings).toHaveLength(1);
  });

  test("still removes the second label after the first fails", async () => {
    const { run, calls } = createFakeCommandRunner([
      fail("network error"),
      ghApiOk([]),
    ]);
    const { log } = createFakeLogger();
    await removeTerminalLabels(
      { run, ghToken: "token" },
      "octo-owner",
      "atelier-works",
      7,
      ["factory:wip", "factory:fix"],
      log,
    );
    expect(calls).toHaveLength(2);
  });
});
