import { describe, expect, test } from "bun:test";
import type { HoldRowView, HoldsSnapshot } from "../api/guards/holds.ts";
import type {
  ConsoleSummary,
  SummaryFailure,
  SummaryNotice,
} from "../api/guards/summary.ts";
import type {
  SystemDeployment,
  SystemFetcher,
  SystemOrphanFailure,
  SystemStatus,
} from "../api/guards/systemStatus.ts";
import { SYSTEM_STATUS_LIMIT } from "../api/systemQueries.ts";
import {
  BAND_LOADING_TEXT,
  type BandLevel,
  type BandRow,
  type BandRowId,
  type BandSource,
  bandLevelInfo,
  bandLevelRank,
  HOST_ACTION_NOTICE_KIND,
  isBandRowLoading,
  summaryBandRows,
} from "./summaryBand.ts";
import { noticeDetailPath } from "./systemView.ts";

const NOW = Date.parse("2026-10-26T03:00:00.000Z");
const FUTURE = "2026-10-26T04:00:00.000Z";
const PAST = "2026-10-26T02:00:00.000Z";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function loaded<T>(data: T): BandSource<T> {
  return { data, isError: false };
}

function holdRow(expiresAt: string, id = 1): HoldRowView {
  return {
    id,
    scope: "merge",
    target: "o/r",
    reason: "wait",
    holder_kind: "human",
    holder: "human",
    created_at: PAST,
    expires_at: expiresAt,
  };
}

const NO_HOLDS: HoldsSnapshot = {
  holds: { ok: true, rows: [] },
  freezes: { ok: true, schedule: [], deploy: [] },
};

function holdsWith(rows: HoldRowView[]): HoldsSnapshot {
  return { ...NO_HOLDS, holds: { ok: true, rows } };
}

const DEPLOYMENT: SystemDeployment = {
  sha_from: SHA_A,
  sha_to: SHA_B,
  changed_paths: ["a"],
  result: "success",
  needs_host_action: false,
  occurred_at: PAST,
};

const FETCHER_OK: SystemFetcher = {
  availability: "available",
  state: "ok",
  sha: SHA_B,
  checked_at: PAST,
  error: null,
  assessment: "ok",
  minutes_since_check: 2,
  next_action: null,
};

const ORPHAN: SystemOrphanFailure = {
  job_failure_id: 1,
  flow_path: "f/factory/poll_issues",
  job_id: "x",
  step: null,
  error: "boom",
  occurred_at: PAST,
};

function orphans(count: number): SystemOrphanFailure[] {
  return Array.from({ length: count }, (_, index) => ({
    ...ORPHAN,
    job_failure_id: index + 1,
  }));
}

function status(overrides: Partial<SystemStatus> = {}): SystemStatus {
  return {
    deployed_sha: SHA_B,
    deployment: DEPLOYMENT,
    fetcher: FETCHER_OK,
    orphan_failures: [],
    info_notices: [],
    resolved_notices: [],
    worker_load: null,
    ...overrides,
  };
}

function auditFailure(
  id: number,
  superseded?: boolean,
  kind = "audit",
): SummaryFailure {
  return {
    work_item_id: id,
    kind,
    owner: "o",
    repo: "r",
    issue_number: null,
    issue_url: null,
    pr_number: null,
    title: "t",
    status: "failed",
    updated_at: PAST,
    status_note: null,
    status_changed_at: PAST,
    job_failure_id: id,
    flow_path: "f",
    job_id: null,
    step: null,
    error: "e",
    occurred_at: PAST,
    ...(superseded === undefined ? {} : { superseded }),
  };
}

function notice(id: number, kind: string): SummaryNotice {
  return {
    notice_id: id,
    kind,
    message: "m",
    resolved: false,
    created_at: PAST,
    severity: "action",
    resolvable: true,
  };
}

function summary(
  failures: SummaryFailure[],
  auditFailuresOpen?: number,
  notices: SummaryNotice[] = [],
  noticeTotal: number = notices.length,
): ConsoleSummary {
  return {
    counts: {
      approvals: 0,
      failures: failures.length,
      notices: noticeTotal,
      ...(auditFailuresOpen === undefined
        ? {}
        : { audit_failures_open: auditFailuresOpen }),
    },
    approvals: [],
    failures,
    notices,
  };
}

const LOADING = { data: undefined, isError: false };
const FAILED = { data: undefined, isError: true };

type Sources = {
  holds: BandSource<HoldsSnapshot>;
  status: BandSource<SystemStatus>;
  summary: BandSource<ConsoleSummary>;
};

const CALM: Sources = {
  holds: loaded(NO_HOLDS),
  status: loaded(status()),
  summary: loaded(summary([], 0)),
};

function rowOf(id: BandRowId, sources: Partial<Sources> = {}): BandRow {
  const row = summaryBandRows({ ...CALM, ...sources }, NOW).find(
    (candidate) => candidate.id === id,
  );
  if (row === undefined) {
    throw new Error(`no row ${id}`);
  }
  return row;
}

describe("bandLevelInfo", () => {
  const LEVELS: BandLevel[] = ["normal", "caution", "action", "none"];

  test.each(LEVELS)("gives %s a Japanese label", (level) => {
    expect(bandLevelInfo(level).label.length).toBeGreaterThan(0);
  });

  test("labels the three judged levels", () => {
    expect(
      (["normal", "caution", "action"] as const).map(
        (level) => bandLevelInfo(level).label,
      ),
    ).toEqual(["正常", "注意", "要対応"]);
  });

  test("gives each level its own symbol, so color is not the only cue", () => {
    expect(
      new Set(LEVELS.map((level) => bandLevelInfo(level).symbol)).size,
    ).toBe(4);
  });

  test("ranks action above caution above normal", () => {
    expect([
      bandLevelRank("normal"),
      bandLevelRank("caution"),
      bandLevelRank("action"),
    ]).toEqual([1, 2, 3]);
  });

  test("ranks an undecided level below normal", () => {
    expect(bandLevelRank("none")).toBe(0);
  });
});

describe("summaryBandRows", () => {
  test("lists the chips in order", () => {
    expect(summaryBandRows(CALM, NOW).map((row) => row.id)).toEqual([
      "actionable",
      "holds",
      "deployment",
      "fetcher",
      "failures",
    ]);
  });

  test("leaves out the info notices and the worker load, which no action follows", () => {
    expect(
      summaryBandRows(CALM, NOW).some((row) =>
        ["info", "worker", "orphan", "audit"].includes(row.id),
      ),
    ).toBe(false);
  });

  test("gives every chip a label", () => {
    expect(
      summaryBandRows(CALM, NOW).every((row) => row.label.length > 0),
    ).toBe(true);
  });

  test("is ready and fresh when every fetch has a value", () => {
    expect(
      summaryBandRows(CALM, NOW).map((row) => [row.state, row.stale]),
    ).toEqual(Array.from({ length: 5 }, () => ["ready", false]));
  });
});

describe("the actionable chip", () => {
  test("is normal without items that need action", () => {
    expect(rowOf("actionable").level).toBe("normal");
  });

  test("says there is none", () => {
    expect(rowOf("actionable").text).toBe("なし");
  });

  test("counts the approvals, the failures and the notices of the inbox", () => {
    const withApproval: ConsoleSummary = {
      ...summary([], 0),
      counts: { approvals: 2, failures: 0, notices: 1, audit_failures_open: 0 },
      approvals: [],
      notices: [notice(1, "main_ci_failed")],
    };
    expect(rowOf("actionable", { summary: loaded(withApproval) }).count).toBe(
      3,
    );
  });

  test("is a caution when something needs action", () => {
    expect(
      rowOf("actionable", {
        summary: loaded(summary([], 0, [notice(1, "main_ci_failed")])),
      }).level,
    ).toBe("caution");
  });

  test("states the count", () => {
    expect(
      rowOf("actionable", {
        summary: loaded(summary([], 0, [notice(1, "main_ci_failed")])),
      }).text,
    ).toBe("1件");
  });

  test("does not count an audit failure that a later audit reported", () => {
    expect(
      rowOf("actionable", {
        summary: loaded(summary([auditFailure(1, true)], 0)),
      }).count,
    ).toBe(0);
  });

  test("opens the inbox screen", () => {
    expect(rowOf("actionable").target).toEqual({ kind: "route", to: "/" });
  });

  test("is undecided while loading", () => {
    expect(rowOf("actionable", { summary: LOADING }).level).toBe("none");
  });
});

describe("the holds chip", () => {
  test("is normal when nothing is held", () => {
    expect(rowOf("holds").level).toBe("normal");
  });

  test("states that nothing is held", () => {
    expect(rowOf("holds").text).toBe("なし");
  });

  test("counts zero active holds", () => {
    expect(rowOf("holds").count).toBe(0);
  });

  test("is a caution for one active hold", () => {
    expect(
      rowOf("holds", { holds: loaded(holdsWith([holdRow(FUTURE)])) }).level,
    ).toBe("caution");
  });

  test("counts a hold, a schedule freeze and a deploy hold together", () => {
    const data: HoldsSnapshot = {
      holds: { ok: true, rows: [holdRow(FUTURE)] },
      freezes: {
        ok: true,
        schedule: [
          {
            id: "0a1b2c3d",
            target: "f/factory/x",
            reason: "r",
            holder_kind: "human",
            holder: "h",
            created_at: PAST,
            expires_at: FUTURE,
          },
        ],
        deploy: [
          {
            id: "1b2c3d4e",
            reason: "r",
            holder_kind: "human",
            holder: "h",
            created_at: PAST,
            expires_at: FUTURE,
          },
        ],
      },
    };
    expect(rowOf("holds", { holds: loaded(data) }).count).toBe(3);
  });

  test("states the active count", () => {
    expect(
      rowOf("holds", {
        holds: loaded(holdsWith([holdRow(FUTURE), holdRow(FUTURE, 2)])),
      }).text,
    ).toBe("有効2件");
  });

  test("does not count a hold whose time ran out after the fetch", () => {
    expect(
      rowOf("holds", { holds: loaded(holdsWith([holdRow(PAST)])) }).count,
    ).toBe(0);
  });

  test("stays normal for a hold that expired, which stops nothing", () => {
    expect(
      rowOf("holds", { holds: loaded(holdsWith([holdRow(PAST)])) }).level,
    ).toBe("normal");
  });

  test("counts only the active hold next to an expired one", () => {
    expect(
      rowOf("holds", {
        holds: loaded(holdsWith([holdRow(PAST), holdRow(FUTURE, 2)])),
      }).text,
    ).toBe("有効1件");
  });

  test("is a caution for the active hold next to an expired one", () => {
    expect(
      rowOf("holds", {
        holds: loaded(holdsWith([holdRow(PAST), holdRow(FUTURE, 2)])),
      }).level,
    ).toBe("caution");
  });

  test("needs action when the holds table cannot be read", () => {
    const data: HoldsSnapshot = {
      ...NO_HOLDS,
      holds: { ok: false, kind: "read_failed", reason: "boom" },
    };
    expect(rowOf("holds", { holds: loaded(data) }).level).toBe("action");
  });

  test("names the holds table when only it cannot be read", () => {
    const data: HoldsSnapshot = {
      ...NO_HOLDS,
      holds: { ok: false, kind: "read_failed", reason: "boom" },
    };
    expect(rowOf("holds", { holds: loaded(data) }).text).toBe(
      "保留の表を読めません",
    );
  });

  test("needs action when the freezes cannot be read", () => {
    const data: HoldsSnapshot = {
      ...NO_HOLDS,
      freezes: { ok: false, reason: "boom" },
    };
    expect(rowOf("holds", { holds: loaded(data) }).level).toBe("action");
  });

  test("names the freezes when only they cannot be read", () => {
    const data: HoldsSnapshot = {
      ...NO_HOLDS,
      freezes: { ok: false, reason: "boom" },
    };
    expect(rowOf("holds", { holds: loaded(data) }).text).toBe(
      "凍結の変数を読めません",
    );
  });

  test("names both when neither can be read", () => {
    const data: HoldsSnapshot = {
      holds: { ok: false, kind: "corrupt", reason: "boom" },
      freezes: { ok: false, reason: "boom" },
    };
    expect(rowOf("holds", { holds: loaded(data) }).text).toBe(
      "保留と凍結を読めません",
    );
  });

  test("has no count when a source cannot be read", () => {
    const data: HoldsSnapshot = {
      ...NO_HOLDS,
      freezes: { ok: false, reason: "boom" },
    };
    expect(rowOf("holds", { holds: loaded(data) }).count).toBeNull();
  });

  test("is loading while the fetch has not returned", () => {
    expect(rowOf("holds", { holds: LOADING }).state).toBe("loading");
  });

  test("says it is loading", () => {
    expect(rowOf("holds", { holds: LOADING }).text).toBe(BAND_LOADING_TEXT);
  });

  test("needs action when the whole fetch failed, as when a part cannot be read", () => {
    expect(rowOf("holds", { holds: FAILED }).level).toBe("action");
  });

  test("is in error when the fetch failed", () => {
    expect(rowOf("holds", { holds: FAILED }).state).toBe("error");
  });

  test("says the fetch failed", () => {
    expect(rowOf("holds", { holds: FAILED }).text).toBe("取得できませんでした");
  });

  test("shows the previous value, marked stale, when a refetch failed", () => {
    const row = rowOf("holds", {
      holds: { data: holdsWith([holdRow(FUTURE)]), isError: true },
    });
    expect([row.level, row.state, row.stale]).toEqual([
      "caution",
      "ready",
      true,
    ]);
  });

  test("points at the holds section of the status tab", () => {
    expect(rowOf("holds").target).toEqual({
      kind: "section",
      tab: "status",
      targetId: "holds-heading",
    });
  });
});

describe("the deployment chip", () => {
  const WITH_HOST_ACTION = summary([], 0, [
    notice(1, HOST_ACTION_NOTICE_KIND),
    notice(2, HOST_ACTION_NOTICE_KIND),
    notice(3, "main_ci_failed"),
  ]);

  test("is normal for a success with no host action left", () => {
    expect(rowOf("deployment").level).toBe("normal");
  });

  test("states a success", () => {
    expect(rowOf("deployment").text).toBe("成功");
  });

  test("is a caution while a host action notice is unresolved", () => {
    expect(
      rowOf("deployment", { summary: loaded(WITH_HOST_ACTION) }).level,
    ).toBe("caution");
  });

  test("counts only the host action notices", () => {
    expect(
      rowOf("deployment", { summary: loaded(WITH_HOST_ACTION) }).text,
    ).toBe("ホストの作業2件が残っています");
  });

  test("does not take the latest deployment's host action flag as still open", () => {
    expect(
      rowOf("deployment", {
        status: loaded(
          status({ deployment: { ...DEPLOYMENT, needs_host_action: true } }),
        ),
      }).level,
    ).toBe("normal");
  });

  test("needs action for a failure", () => {
    expect(
      rowOf("deployment", {
        status: loaded(
          status({ deployment: { ...DEPLOYMENT, result: "failed" } }),
        ),
      }).level,
    ).toBe("action");
  });

  test("states a failure", () => {
    expect(
      rowOf("deployment", {
        status: loaded(
          status({ deployment: { ...DEPLOYMENT, result: "failed" } }),
        ),
      }).text,
    ).toBe("失敗");
  });

  test("states a failure together with the host action left", () => {
    expect(
      rowOf("deployment", {
        status: loaded(
          status({ deployment: { ...DEPLOYMENT, result: "failed" } }),
        ),
        summary: loaded(WITH_HOST_ACTION),
      }).text,
    ).toBe("失敗。ホストの作業2件も残っています");
  });

  test("needs action for a result it does not know", () => {
    expect(
      rowOf("deployment", {
        status: loaded(
          status({ deployment: { ...DEPLOYMENT, result: "weird" } }),
        ),
      }).level,
    ).toBe("action");
  });

  test("is undecided without a record and without a host action notice", () => {
    expect(
      rowOf("deployment", { status: loaded(status({ deployment: null })) })
        .level,
    ).toBe("none");
  });

  test("says there is no record", () => {
    expect(
      rowOf("deployment", { status: loaded(status({ deployment: null })) })
        .text,
    ).toBe("記録なし");
  });

  test("is a caution for a host action notice even without a deployment record", () => {
    expect(
      rowOf("deployment", {
        status: loaded(status({ deployment: null })),
        summary: loaded(WITH_HOST_ACTION),
      }).level,
    ).toBe("caution");
  });

  const FLAGGED = loaded(
    status({ deployment: { ...DEPLOYMENT, needs_host_action: true } }),
  );

  test("waits while the summary is loading, instead of falling back", () => {
    expect(
      rowOf("deployment", { status: FLAGGED, summary: LOADING }).state,
    ).toBe("loading");
  });

  test("is undecided while the summary is loading", () => {
    expect(
      rowOf("deployment", { status: FLAGGED, summary: LOADING }).level,
    ).toBe("none");
  });

  test("falls back to the deployment flag only when the summary failed with no value", () => {
    expect(rowOf("deployment", { status: FLAGGED, summary: FAILED }).text).toBe(
      "ホストの作業が必要(通知の取得に失敗)",
    );
  });

  test("is a caution under that fallback", () => {
    expect(
      rowOf("deployment", { status: FLAGGED, summary: FAILED }).level,
    ).toBe("caution");
  });

  test("is normal under the fallback when no host action is flagged", () => {
    expect(rowOf("deployment", { summary: FAILED }).level).toBe("normal");
  });

  test("falls back to the flag when the notice list was cut and holds none", () => {
    expect(
      rowOf("deployment", {
        status: FLAGGED,
        summary: loaded(summary([auditFailure(1, false)], 0, [], 250)),
      }).text,
    ).toBe("ホストの作業が必要(通知を確認できません)");
  });

  test("states a lower bound when the list was cut but holds a host action notice", () => {
    expect(
      rowOf("deployment", {
        summary: loaded(
          summary([], 0, [notice(5, HOST_ACTION_NOTICE_KIND)], 250),
        ),
      }).text,
    ).toBe("ホストの作業1件以上が残っています");
  });

  test("marks the count as a lower bound then", () => {
    expect(
      rowOf("deployment", {
        summary: loaded(
          summary([], 0, [notice(5, HOST_ACTION_NOTICE_KIND)], 250),
        ),
      }).countAtLeast,
    ).toBe(true);
  });

  test("does not mark a complete count as a lower bound", () => {
    expect(
      rowOf("deployment", { summary: loaded(WITH_HOST_ACTION) }).countAtLeast,
    ).toBe(false);
  });

  test("opens the newest host action notice in the inbox screen", () => {
    expect(
      rowOf("deployment", { summary: loaded(WITH_HOST_ACTION) }).target,
    ).toEqual({ kind: "route", to: noticeDetailPath(1) });
  });

  test("opens the release section when no host action is left", () => {
    expect(rowOf("deployment").target.kind).toBe("section");
  });

  test("is loading while the status has not returned", () => {
    expect(rowOf("deployment", { status: LOADING }).state).toBe("loading");
  });

  test("is stale when the summary refetch failed", () => {
    expect(
      rowOf("deployment", {
        summary: { data: summary([], 0), isError: true },
      }).stale,
    ).toBe(true);
  });

  test("points at the release section of the status tab", () => {
    expect(rowOf("deployment").target).toEqual({
      kind: "section",
      tab: "status",
      targetId: "release-heading",
    });
  });
});

describe("the fetcher chip", () => {
  function withFetcher(fetcher: SystemFetcher): Partial<Sources> {
    return { status: loaded(status({ fetcher })) };
  }

  test("is normal for a fetch that is up to date", () => {
    expect(rowOf("fetcher").level).toBe("normal");
  });

  test("needs action for a failed fetch", () => {
    expect(
      rowOf("fetcher", withFetcher({ ...FETCHER_OK, state: "failed" })).level,
    ).toBe("action");
  });

  test("needs action when the judgment itself is a failure", () => {
    expect(
      rowOf("fetcher", withFetcher({ ...FETCHER_OK, assessment: "failed" }))
        .level,
    ).toBe("action");
  });

  test("is a caution for a pinned version", () => {
    expect(
      rowOf("fetcher", withFetcher({ ...FETCHER_OK, state: "pinned" })).level,
    ).toBe("caution");
  });

  test("needs action for a stale record, which may mean the fetch stopped", () => {
    expect(
      rowOf("fetcher", withFetcher({ ...FETCHER_OK, assessment: "stale" }))
        .level,
    ).toBe("action");
  });

  test("needs action when the status file cannot be read", () => {
    expect(
      rowOf(
        "fetcher",
        withFetcher({ availability: "unavailable", reason: "missing" }),
      ).level,
    ).toBe("action");
  });

  test("uses the label of the fetch as the text", () => {
    expect(rowOf("fetcher").text).toBe("取り込み済み");
  });

  test("says the state cannot be read", () => {
    expect(
      rowOf(
        "fetcher",
        withFetcher({ availability: "unavailable", reason: "missing" }),
      ).text,
    ).toBe("状態を読めません");
  });

  test("is loading while the status has not returned", () => {
    expect(rowOf("fetcher", { status: LOADING }).state).toBe("loading");
  });

  test("points at the release section of the status tab", () => {
    expect(rowOf("fetcher").target).toEqual({
      kind: "section",
      tab: "status",
      targetId: "release-heading",
    });
  });
});

describe("the failures chip", () => {
  test("is normal with no failure", () => {
    expect(rowOf("failures").level).toBe("normal");
  });

  test("states both counts", () => {
    expect(rowOf("failures").text).toBe("監査0件、紐づかない0件");
  });

  test("is a caution for one open audit failure", () => {
    expect(
      rowOf("failures", {
        summary: loaded(summary([auditFailure(1, false)], 1)),
      }).level,
    ).toBe("caution");
  });

  test("states the open audit failures in words, never hiding them", () => {
    expect(
      rowOf("failures", {
        summary: loaded(summary([auditFailure(1, false)], 1)),
      }).text,
    ).toBe("監査1件、紐づかない0件");
  });

  test("adds the audit failures and the failures without a work item", () => {
    expect(
      rowOf("failures", {
        summary: loaded(summary([auditFailure(1, false)], 2)),
        status: loaded(status({ orphan_failures: orphans(5) })),
      }).count,
    ).toBe(7);
  });

  test("does not call the chip normal while failures without a work item remain", () => {
    expect(
      rowOf("failures", {
        status: loaded(status({ orphan_failures: orphans(40) })),
      }).level,
    ).toBe("none");
  });

  test("keeps the audit judgment when failures without a work item also remain", () => {
    expect(
      rowOf("failures", {
        summary: loaded(summary([auditFailure(1, false)], 1)),
        status: loaded(status({ orphan_failures: orphans(40) })),
      }).level,
    ).toBe("caution");
  });

  test("keeps the count of the failures without a work item", () => {
    expect(
      rowOf("failures", {
        status: loaded(status({ orphan_failures: orphans(40) })),
      }).count,
    ).toBe(40);
  });

  test("states a lower bound when the failures without a work item hit the limit", () => {
    expect(
      rowOf("failures", {
        status: loaded(
          status({ orphan_failures: orphans(SYSTEM_STATUS_LIMIT) }),
        ),
      }).text,
    ).toBe(`監査0件、紐づかない${String(SYSTEM_STATUS_LIMIT)}件以上`);
  });

  test("marks the count as a lower bound at the limit", () => {
    expect(
      rowOf("failures", {
        status: loaded(
          status({ orphan_failures: orphans(SYSTEM_STATUS_LIMIT) }),
        ),
      }).countAtLeast,
    ).toBe(true);
  });

  test("does not mark the count below the limit", () => {
    expect(
      rowOf("failures", {
        status: loaded(
          status({ orphan_failures: orphans(SYSTEM_STATUS_LIMIT - 1) }),
        ),
      }).countAtLeast,
    ).toBe(false);
  });

  test("still states the failures without a work item", () => {
    expect(
      rowOf("failures", {
        status: loaded(status({ orphan_failures: orphans(40) })),
      }).text,
    ).toBe("監査0件、紐づかない40件");
  });

  test("uses the open count from the backend over the listed rows", () => {
    expect(
      rowOf("failures", {
        summary: loaded(
          summary([auditFailure(1, false), auditFailure(2, true)], 1),
        ),
      }).text,
    ).toContain("監査1件");
  });

  test("counts every audit failure when the backend sends no open count", () => {
    expect(
      rowOf("failures", {
        summary: loaded(
          summary([
            auditFailure(1),
            auditFailure(2, true),
            auditFailure(3, false, "issue"),
          ]),
        ),
      }).text,
    ).toContain("監査2件");
  });

  test("is normal when every audit failure was reported by a later audit", () => {
    expect(
      rowOf("failures", {
        summary: loaded(summary([auditFailure(1, true)], 0)),
      }).level,
    ).toBe("normal");
  });

  test("opens the audit failures when there is one", () => {
    expect(
      rowOf("failures", {
        summary: loaded(summary([auditFailure(1, false)], 1)),
      }).target,
    ).toEqual({
      kind: "section",
      tab: "failures",
      targetId: "audit-failures-heading",
    });
  });

  test("opens the failures without a work item when only they exist", () => {
    expect(
      rowOf("failures", {
        status: loaded(status({ orphan_failures: orphans(3) })),
      }).target,
    ).toEqual({
      kind: "section",
      tab: "failures",
      targetId: "orphan-failures-heading",
    });
  });

  test("keeps showing the audit failures when the status cannot be read", () => {
    const row = rowOf("failures", {
      summary: loaded(summary([auditFailure(1, false)], 1)),
      status: FAILED,
    });
    expect([row.level, row.text, row.count, row.state]).toEqual([
      "caution",
      "監査1件、紐づかない 取得できません",
      null,
      "error",
    ]);
  });

  test("names the failures without a work item as loading while the status loads", () => {
    expect(rowOf("failures", { status: LOADING }).text).toBe(
      "監査0件、紐づかない 取得中",
    );
  });

  test("is undecided when the summary cannot be read", () => {
    expect(rowOf("failures", { summary: FAILED }).level).toBe("none");
  });

  test("is stale when a refetch failed but a value remains", () => {
    expect(
      rowOf("failures", {
        status: { data: status(), isError: true },
      }).stale,
    ).toBe(true);
  });
});

describe("isBandRowLoading", () => {
  test("is true for a chip whose fetch has not returned", () => {
    expect(isBandRowLoading(rowOf("holds", { holds: LOADING }))).toBe(true);
  });

  test("is false for a chip whose fetch failed", () => {
    expect(isBandRowLoading(rowOf("holds", { holds: FAILED }))).toBe(false);
  });

  test("is false for a chip with a value", () => {
    expect(isBandRowLoading(rowOf("holds"))).toBe(false);
  });

  test("does not depend on the words of the chip", () => {
    const fake: BandRow = {
      ...rowOf("holds"),
      text: BAND_LOADING_TEXT,
    };
    expect(isBandRowLoading(fake)).toBe(false);
  });
});
