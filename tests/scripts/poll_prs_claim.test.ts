// Tests for f/factory/poll_prs.ts's claimPr (2026-09-27 PR label cleanup:
// a PR claim consumes whichever trigger label — review_label or fix_label —
// fired this cycle, mirroring lib/github.ts's claimIssue; no wip label, no
// assignee). claimPr delegates the actual label DELETE to lib/github.ts's
// removeLabel, so the fake responses below are `gh api -i`-shaped
// (ghApiOk/ghApiStdout), matching what removeLabel's own callGhApi expects —
// not a bare command-exit-code response.

import { describe, expect, test } from "bun:test";
import { claimPr } from "../../f/factory/poll_prs.ts";
import { createFakeCommandRunner, fail, ghApiOk } from "../lib/testSupport.ts";

function fakeIssue(labels: string[]) {
  return {
    number: 7,
    title: "t",
    body: null,
    html_url: "https://github.com/octo-owner/atelier-works/issues/7",
    state: "open",
    labels,
    assignees: [],
  };
}

describe("claimPr", () => {
  test("reports claimed when the trigger label is gone after removal", async () => {
    const { run } = createFakeCommandRunner([
      ghApiOk({}), // DELETE trigger label
      ghApiOk(fakeIssue([])),
    ]);
    const result = await claimPr(
      { run, ghToken: "token" },
      "octo-owner",
      "atelier-works",
      7,
      "factory:review",
    );
    expect(result).toEqual({ claimed: true });
  });

  test("does not post an assignees request", async () => {
    const { run, calls } = createFakeCommandRunner([
      ghApiOk({}),
      ghApiOk(fakeIssue([])),
    ]);
    await claimPr(
      { run, ghToken: "token" },
      "octo-owner",
      "atelier-works",
      7,
      "factory:review",
    );
    const assigneeCall = calls.find((call) =>
      call.argv.some((arg) => arg.includes("assignees")),
    );
    expect(assigneeCall).toBeUndefined();
  });

  test("issues a DELETE for the trigger label", async () => {
    const { run, calls } = createFakeCommandRunner([
      ghApiOk({}),
      ghApiOk(fakeIssue([])),
    ]);
    await claimPr(
      { run, ghToken: "token" },
      "octo-owner",
      "atelier-works",
      7,
      "factory:review",
    );
    expect(calls[0]?.argv.join(" ")).toContain("DELETE");
    expect(decodeURIComponent(calls[0]?.argv.join(" ") ?? "")).toContain(
      "factory:review",
    );
  });

  test("reports not claimed when the label removal itself fails", async () => {
    const { run } = createFakeCommandRunner([fail("rate limited")]);
    const result = await claimPr(
      { run, ghToken: "token" },
      "octo-owner",
      "atelier-works",
      7,
      "factory:review",
    );
    expect(result.claimed).toBe(false);
  });

  test("reports not claimed when the trigger label is still present after removal (race)", async () => {
    const { run } = createFakeCommandRunner([
      ghApiOk({}),
      ghApiOk(fakeIssue(["factory:review"])),
    ]);
    const result = await claimPr(
      { run, ghToken: "token" },
      "octo-owner",
      "atelier-works",
      7,
      "factory:review",
    );
    expect(result).toEqual({
      claimed: false,
      reason: "trigger label factory:review still present after claim",
    });
  });
});
