import { describe, expect, test } from "bun:test";
import type { HoldsSnapshot } from "../api/guards/holds.ts";
import { deployApprovalsView } from "./deployApprovalsView.ts";

const BASE: HoldsSnapshot = {
  holds: { ok: true, rows: [] },
  freezes: { ok: true, schedule: [], deploy: [] },
};
const SHA = "0123456789abcdef0123456789abcdef01234567";
const PENDING = {
  sha: SHA,
  protected_paths: ["f/factory/self_update.ts"],
  protected_path_count: 3,
  requested_at: "2026-11-05T01:00:00.000Z",
};

describe("deployApprovalsView", () => {
  test("shows nothing when the backend does not send the approvals", () => {
    expect(deployApprovalsView(BASE)).toEqual({ kind: "none" });
  });

  test("shows nothing when nothing waits", () => {
    expect(
      deployApprovalsView({
        ...BASE,
        deploy_approvals: { ok: true, pending: [] },
      }),
    ).toEqual({
      kind: "none",
    });
  });

  test("shows the failure when the approvals cannot be read", () => {
    expect(
      deployApprovalsView({
        ...BASE,
        deploy_approvals: { ok: false, reason: "db down" },
      }).kind,
    ).toBe("failed");
  });

  test("counts the paths that the list leaves out", () => {
    const view = deployApprovalsView({
      ...BASE,
      deploy_approvals: { ok: true, pending: [PENDING] },
    });
    expect(
      view.kind === "pending" ? view.items[0]?.hiddenPathCount : null,
    ).toBe(2);
  });

  test("makes the hidden characters of a path visible", () => {
    const view = deployApprovalsView({
      ...BASE,
      deploy_approvals: {
        ok: true,
        pending: [{ ...PENDING, protected_paths: ["a‮b.ts"] }],
      },
    });
    expect(
      view.kind === "pending" ? view.items[0]?.paths[0] : null,
    ).not.toContain("‮");
  });
});
