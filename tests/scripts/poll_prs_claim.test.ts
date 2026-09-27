// Tests for f/factory/poll_prs.ts's claimPr (security-auditor/DA fix round 2
// item i: a PR claim adds the wip label only, never an assignee — see
// claimPr's own doc comment for why). claimPr delegates the actual label
// POST to lib/github.ts's addLabels, so the fake responses below are
// `gh api -i`-shaped (ghApiOk/ghApiStdout), matching what addLabels's own
// callGhApi expects — not a bare command-exit-code response.

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
  test("reports claimed when the wip label sticks", async () => {
    const { run } = createFakeCommandRunner([
      ghApiOk([]),
      ghApiOk(fakeIssue(["factory:wip"])),
    ]);
    const result = await claimPr(
      { run, ghToken: "token" },
      "octo-owner",
      "atelier-works",
      7,
      "factory:wip",
    );
    expect(result).toEqual({ claimed: true });
  });

  test("does not post an assignees request", async () => {
    const { run, calls } = createFakeCommandRunner([
      ghApiOk([]),
      ghApiOk(fakeIssue(["factory:wip"])),
    ]);
    await claimPr(
      { run, ghToken: "token" },
      "octo-owner",
      "atelier-works",
      7,
      "factory:wip",
    );
    const assigneeCall = calls.find((call) =>
      call.argv.some((arg) => arg.includes("assignees")),
    );
    expect(assigneeCall).toBeUndefined();
  });

  test("posts only the wip label, via stdin", async () => {
    const { run, calls } = createFakeCommandRunner([
      ghApiOk([]),
      ghApiOk(fakeIssue(["factory:wip"])),
    ]);
    await claimPr(
      { run, ghToken: "token" },
      "octo-owner",
      "atelier-works",
      7,
      "factory:wip",
    );
    expect(calls[0]?.options?.stdin).toBe(
      JSON.stringify({ labels: ["factory:wip"] }),
    );
  });

  test("reports not claimed when the label POST itself fails", async () => {
    const { run } = createFakeCommandRunner([fail("rate limited")]);
    const result = await claimPr(
      { run, ghToken: "token" },
      "octo-owner",
      "atelier-works",
      7,
      "factory:wip",
    );
    expect(result.claimed).toBe(false);
  });

  test("reports not claimed when the label is missing after re-fetch (race)", async () => {
    const { run } = createFakeCommandRunner([
      ghApiOk([]),
      ghApiOk(fakeIssue([])),
    ]);
    const result = await claimPr(
      { run, ghToken: "token" },
      "octo-owner",
      "atelier-works",
      7,
      "factory:wip",
    );
    expect(result).toEqual({
      claimed: false,
      reason: "wip label factory:wip missing after claim",
    });
  });
});
