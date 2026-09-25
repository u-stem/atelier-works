// Pure decision logic tests for poll_issues.ts's claim path
// (f/factory/lib/poll_support.ts) — spec-cycle2.md §3 M5.

import { describe, expect, test } from "bun:test";
import {
  associationFromLabeledEvent,
  decideIssueActions,
  filterByRepoAllowlist,
  type IssueCandidate,
} from "../../f/factory/lib/poll_support.ts";
import type { LabelerAssociation } from "../../f/factory/lib/types.ts";

const ALLOWED: LabelerAssociation[] = ["OWNER", "MEMBER", "COLLABORATOR"];

function candidate(overrides: Partial<IssueCandidate> = {}): IssueCandidate {
  return {
    owner: "u-stem",
    repo: "atelier-works",
    number: 1,
    title: "Add a thing",
    body: "please add a thing",
    htmlUrl: "https://github.com/u-stem/atelier-works/issues/1",
    labelerAssociation: "OWNER",
    hasActiveWorkItem: false,
    ...overrides,
  };
}

describe("filterByRepoAllowlist", () => {
  test("returns every item unchanged when the allowlist is empty", () => {
    const items = [{ owner: "u-stem", repo: "atelier-works" }];
    expect(filterByRepoAllowlist(items, [])).toEqual(items);
  });

  test("drops items whose owner/repo is not in a non-empty allowlist", () => {
    const items = [
      { owner: "u-stem", repo: "atelier-works" },
      { owner: "u-stem", repo: "other-repo" },
    ];
    const filtered = filterByRepoAllowlist(items, [
      "https://github.com/u-stem/atelier-works",
    ]);
    expect(filtered).toEqual([{ owner: "u-stem", repo: "atelier-works" }]);
  });
});

describe("associationFromLabeledEvent", () => {
  test("returns null when there is no labeled event", () => {
    expect(associationFromLabeledEvent(null)).toBeNull();
  });

  test("returns the event's authorAssociation when present", () => {
    expect(
      associationFromLabeledEvent({ authorAssociation: "COLLABORATOR" }),
    ).toBe("COLLABORATOR");
  });
});

describe("decideIssueActions", () => {
  test("skips an issue that already has an active work item", () => {
    const decisions = decideIssueActions(
      [candidate({ hasActiveWorkItem: true })],
      ALLOWED,
    );
    expect(decisions[0]?.action).toBe("skip_active");
  });

  test("skips an issue whose labeler association is not allowed", () => {
    const decisions = decideIssueActions(
      [candidate({ labelerAssociation: "NONE" })],
      ALLOWED,
    );
    expect(decisions[0]?.action).toBe("skip_association");
  });

  test("reports the disallowed association on a skip_association decision", () => {
    const decisions = decideIssueActions(
      [candidate({ labelerAssociation: "NONE" })],
      ALLOWED,
    );
    const decision = decisions[0];
    expect(
      decision?.action === "skip_association" ? decision.association : null,
    ).toBe("NONE");
  });

  test("does not block on a null labeler association (secondary check only)", () => {
    const decisions = decideIssueActions(
      [candidate({ labelerAssociation: null })],
      ALLOWED,
    );
    expect(decisions[0]?.action).toBe("claim");
  });

  test("claims an issue with an allowed association and no active work item", () => {
    const decisions = decideIssueActions([candidate()], ALLOWED);
    expect(decisions[0]?.action).toBe("claim");
  });
});
