import { describe, expect, test } from "bun:test";
import { ApiFailure } from "../../api/errors.ts";
import type { HoldsSnapshot, StopAllRead } from "../../api/guards/holds.ts";
import {
  arrivalTarget,
  chipJumpParams,
  type FailureQuery,
  type HoldsFetch,
  needsTabSwitch,
  noActiveHoldsOrFreezes,
  sectionNeedsAction,
  sectionRendered,
  shouldDiscardJump,
  shouldFallBackToHeading,
  shouldHighlight,
  shouldRunJump,
  systemFailedTabs,
} from "./systemScreenView.ts";

const OK: FailureQuery = { isError: false, error: null };
const NETWORK: FailureQuery = {
  isError: true,
  error: new ApiFailure({ kind: "network" }),
};
const UNAUTHORIZED: FailureQuery = {
  isError: true,
  error: new ApiFailure({ kind: "unauthorized" }),
};

const FINE = {
  status: OK,
  holds: OK,
  summary: OK,
  deployments: OK,
  config: OK,
};

describe("systemFailedTabs", () => {
  test("is false everywhere when every fetch is fine", () => {
    expect(systemFailedTabs(FINE)).toEqual({
      status: false,
      failures: false,
      history: false,
      config: false,
    });
  });

  test("blames the status and the holds on the status tab", () => {
    expect(systemFailedTabs({ ...FINE, holds: NETWORK }).status).toBe(true);
  });

  test("does not blame the holds on the other tabs", () => {
    const failed = systemFailedTabs({ ...FINE, holds: NETWORK });
    expect([failed.failures, failed.history]).toEqual([false, false]);
  });

  test("blames the summary on the failures tab only", () => {
    expect(systemFailedTabs({ ...FINE, summary: NETWORK })).toEqual({
      status: false,
      failures: true,
      history: false,
      config: false,
    });
  });

  test("blames the deployments on the history tab only", () => {
    expect(systemFailedTabs({ ...FINE, deployments: NETWORK })).toEqual({
      status: false,
      failures: false,
      history: true,
      config: false,
    });
  });

  test("blames the status on all three tabs, which read it", () => {
    expect(systemFailedTabs({ ...FINE, status: NETWORK })).toEqual({
      status: true,
      failures: true,
      history: true,
      config: false,
    });
  });

  test("leaves a login failure to the banner at the top", () => {
    expect(systemFailedTabs({ ...FINE, status: UNAUTHORIZED })).toEqual({
      status: false,
      failures: false,
      history: false,
      config: false,
    });
  });

  test("counts a failed refetch even when an older value remains", () => {
    expect(
      systemFailedTabs({ ...FINE, summary: { ...NETWORK, isError: true } })
        .failures,
    ).toBe(true);
  });
});

describe("systemFailedTabs for the config", () => {
  test("blames the config fetch on the config tab only", () => {
    expect(systemFailedTabs({ ...FINE, config: NETWORK })).toEqual({
      status: false,
      failures: false,
      history: false,
      config: true,
    });
  });

  test("does not blame the status fetch on the config tab", () => {
    expect(systemFailedTabs({ ...FINE, status: NETWORK }).config).toBe(false);
  });

  test("leaves a login failure of the config to the banner", () => {
    expect(systemFailedTabs({ ...FINE, config: UNAUTHORIZED }).config).toBe(
      false,
    );
  });
});

describe("shouldRunJump", () => {
  test("does nothing without a pending jump", () => {
    expect(shouldRunJump(null, "status")).toBe(false);
  });

  test("runs when the target tab is open", () => {
    expect(
      shouldRunJump(
        { tab: "failures", id: "audit-failures-heading" },
        "failures",
      ),
    ).toBe(true);
  });

  test("waits while another tab is still open", () => {
    expect(
      shouldRunJump(
        { tab: "failures", id: "audit-failures-heading" },
        "status",
      ),
    ).toBe(false);
  });
});

describe("needsTabSwitch", () => {
  test("switches to a tab that is not open", () => {
    expect(needsTabSwitch("failures", "status")).toBe(true);
  });

  test("stays on the open tab", () => {
    expect(needsTabSwitch("status", "status")).toBe(false);
  });
});

const T = "2026-11-08T00:00:00.000Z";
const SHA = "0123456789abcdef0123456789abcdef01234567";

const QUIET: HoldsSnapshot = {
  holds: { ok: true, rows: [] },
  freezes: { ok: true, schedule: [], deploy: [] },
};

const HOLD_ROW = {
  id: 1,
  scope: "merge",
  target: "octo/repo",
  reason: "r",
  holder_kind: "human",
  holder: "human",
  created_at: T,
  expires_at: T,
};

const FREEZE_ROW = {
  id: "0a1b2c3d",
  target: "f/factory/poll_issues",
  reason: "r",
  holder_kind: "human",
  holder: "human",
  created_at: T,
  expires_at: T,
};

const WAITING_APPROVAL: HoldsSnapshot = {
  ...QUIET,
  deploy_approvals: {
    ok: true,
    pending: [
      {
        sha: SHA,
        protected_paths: ["f/factory/self_update.ts"],
        protected_path_count: 1,
        requested_at: T,
      },
    ],
  },
};

const NO_APPROVAL: HoldsSnapshot = {
  ...QUIET,
  deploy_approvals: { ok: true, pending: [] },
};

function withStop(stop_all: StopAllRead): HoldsSnapshot {
  return { ...QUIET, stop_all };
}

describe("noActiveHoldsOrFreezes", () => {
  test("is true when both were read and nothing is active", () => {
    expect(noActiveHoldsOrFreezes(QUIET)).toBe(true);
  });

  test("is false when a hold is active", () => {
    expect(
      noActiveHoldsOrFreezes({
        ...QUIET,
        holds: { ok: true, rows: [HOLD_ROW] },
      }),
    ).toBe(false);
  });

  test("is false when a freeze is active", () => {
    expect(
      noActiveHoldsOrFreezes({
        ...QUIET,
        freezes: { ok: true, schedule: [FREEZE_ROW], deploy: [] },
      }),
    ).toBe(false);
  });

  test("is false when the holds could not be read, since nothing can be said of them", () => {
    expect(
      noActiveHoldsOrFreezes({
        ...QUIET,
        holds: { ok: false, kind: "query_failed", reason: "x" },
      }),
    ).toBe(false);
  });

  test("is false when the freezes could not be read", () => {
    expect(
      noActiveHoldsOrFreezes({
        ...QUIET,
        freezes: { ok: false, reason: "x" },
      }),
    ).toBe(false);
  });
});

describe("sectionRendered", () => {
  test("draws the approvals while one waits", () => {
    expect(sectionRendered("deploy-approvals", WAITING_APPROVAL)).toBe(true);
  });

  test("draws the approvals when they could not be read", () => {
    expect(
      sectionRendered("deploy-approvals", {
        ...QUIET,
        deploy_approvals: { ok: false, reason: "x" },
      }),
    ).toBe(true);
  });

  test("draws no approvals when none waits", () => {
    expect(sectionRendered("deploy-approvals", NO_APPROVAL)).toBe(false);
  });

  test("draws no approvals for an older backend", () => {
    expect(sectionRendered("deploy-approvals", QUIET)).toBe(false);
  });

  test("draws the stop-all when the state is known", () => {
    expect(sectionRendered("stop-all", withStop({ kind: "clear" }))).toBe(true);
  });

  test("draws no stop-all for an older backend", () => {
    expect(sectionRendered("stop-all", QUIET)).toBe(false);
  });

  test("draws the holds while one is active", () => {
    expect(
      sectionRendered("holds", {
        ...QUIET,
        holds: { ok: true, rows: [HOLD_ROW] },
      }),
    ).toBe(true);
  });

  test("draws no holds card when nothing is active, which folds into one line", () => {
    expect(sectionRendered("holds", QUIET)).toBe(false);
  });
});

describe("sectionNeedsAction", () => {
  test("asks for an action while an approval waits", () => {
    expect(sectionNeedsAction("deploy-approvals", WAITING_APPROVAL)).toBe(true);
  });

  test("asks for no action when no approval waits", () => {
    expect(sectionNeedsAction("deploy-approvals", NO_APPROVAL)).toBe(false);
  });

  test("asks for no action when the approvals could not be read", () => {
    expect(
      sectionNeedsAction("deploy-approvals", {
        ...QUIET,
        deploy_approvals: { ok: false, reason: "x" },
      }),
    ).toBe(false);
  });

  test("asks for an action while the stop-all is active", () => {
    expect(
      sectionNeedsAction(
        "stop-all",
        withStop({
          kind: "active",
          placed_at: T,
          placed_by: "operator",
          reason: "r",
        }),
      ),
    ).toBe(true);
  });

  test("asks for an action while the stop-all state is corrupt", () => {
    expect(
      sectionNeedsAction(
        "stop-all",
        withStop({ kind: "corrupt", reason: "r" }),
      ),
    ).toBe(true);
  });

  test("asks for no action while the factory runs", () => {
    expect(sectionNeedsAction("stop-all", withStop({ kind: "clear" }))).toBe(
      false,
    );
  });

  test("asks for an action while a hold row is active", () => {
    expect(
      sectionNeedsAction("holds", {
        ...QUIET,
        holds: { ok: true, rows: [HOLD_ROW] },
      }),
    ).toBe(true);
  });

  test("asks for no action when only a freeze is active", () => {
    expect(
      sectionNeedsAction("holds", {
        ...QUIET,
        freezes: { ok: true, schedule: [FREEZE_ROW], deploy: [] },
      }),
    ).toBe(false);
  });
});

function fetchOf(overrides: Partial<HoldsFetch> = {}): HoldsFetch {
  return {
    data: WAITING_APPROVAL,
    isError: false,
    isFetching: false,
    ...overrides,
  };
}

describe("arrivalTarget", () => {
  test("hands the pending section to the sections once the fetch is settled", () => {
    expect(arrivalTarget("holds", fetchOf())).toBe("holds");
  });

  test("holds the arrival back while the fetch runs", () => {
    expect(arrivalTarget("holds", fetchOf({ isFetching: true }))).toBeNull();
  });

  test("hands nothing when nothing is pending", () => {
    expect(arrivalTarget(null, fetchOf())).toBeNull();
  });
});

describe("shouldFallBackToHeading", () => {
  test("waits for the section while the first fetch runs", () => {
    expect(
      shouldFallBackToHeading(
        "deploy-approvals",
        fetchOf({ data: undefined, isFetching: true }),
      ),
    ).toBe(false);
  });

  test("lands on the heading when the fetch failed and there is no value", () => {
    expect(
      shouldFallBackToHeading(
        "deploy-approvals",
        fetchOf({ data: undefined, isError: true }),
      ),
    ).toBe(true);
  });

  test("lands on the heading when the settled data draws no such section", () => {
    expect(
      shouldFallBackToHeading(
        "deploy-approvals",
        fetchOf({ data: NO_APPROVAL }),
      ),
    ).toBe(true);
  });

  test("waits for the section to mount when the settled data draws it", () => {
    expect(shouldFallBackToHeading("deploy-approvals", fetchOf())).toBe(false);
  });

  test("waits while a refetch runs, since the data may change", () => {
    expect(
      shouldFallBackToHeading(
        "deploy-approvals",
        fetchOf({ data: NO_APPROVAL, isFetching: true }),
      ),
    ).toBe(false);
  });

  test("does nothing without a pending section", () => {
    expect(shouldFallBackToHeading(null, fetchOf({ data: NO_APPROVAL }))).toBe(
      false,
    );
  });
});

describe("shouldHighlight", () => {
  test("highlights a section that needs an action once the fetch settled", () => {
    expect(shouldHighlight("deploy-approvals", fetchOf())).toBe(true);
  });

  test("does not highlight on a value that a refetch may replace", () => {
    expect(
      shouldHighlight("deploy-approvals", fetchOf({ isFetching: true })),
    ).toBe(false);
  });

  test("does not highlight a section that needs no action", () => {
    expect(
      shouldHighlight("deploy-approvals", fetchOf({ data: NO_APPROVAL })),
    ).toBe(false);
  });

  test("does not highlight without a value", () => {
    expect(
      shouldHighlight("deploy-approvals", fetchOf({ data: undefined })),
    ).toBe(false);
  });
});

describe("shouldDiscardJump", () => {
  test("has nothing to discard without a pending section", () => {
    expect(shouldDiscardJump(null, "failures")).toBe(false);
  });

  test("keeps the jump when the tab of the section is selected again", () => {
    expect(shouldDiscardJump("holds", "status")).toBe(false);
  });

  test("discards the jump when the person moves to another tab meanwhile", () => {
    expect(shouldDiscardJump("holds", "failures")).toBe(true);
  });
});

describe("chipJumpParams", () => {
  test("removes the pending section even when the chip leads to the tab that is already open", () => {
    expect(
      chipJumpParams(new URLSearchParams("section=holds"), "status").has(
        "section",
      ),
    ).toBe(false);
  });

  test("removes the pending section when the chip leads to another tab", () => {
    expect(
      chipJumpParams(new URLSearchParams("section=holds"), "failures").has(
        "section",
      ),
    ).toBe(false);
  });

  test("opens the tab that the chip leads to", () => {
    expect(
      chipJumpParams(new URLSearchParams("section=holds"), "failures").get(
        "tab",
      ),
    ).toBe("failures");
  });

  test("keeps other queries", () => {
    expect(
      chipJumpParams(
        new URLSearchParams("section=holds&other=1"),
        "status",
      ).get("other"),
    ).toBe("1");
  });
});
