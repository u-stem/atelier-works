import { describe, expect, test } from "bun:test";
import type { HoldRowView, HoldsSnapshot } from "../api/guards/holds.ts";
import type { ConsoleSummary, SummaryFailure } from "../api/guards/summary.ts";
import type {
  SystemDeployment,
  SystemFetcher,
  SystemOrphanFailure,
  SystemStatus,
} from "../api/guards/systemStatus.ts";
import type { WorkerLoad } from "../api/guards/workerLoad.ts";
import {
  auditBandRow,
  BAND_LOADING_TEXT,
  type BandLevel,
  type BandSource,
  bandLevelInfo,
  bandLevelRank,
  deploymentBandRow,
  fetcherBandRow,
  holdsBandRow,
  infoBandRow,
  isBandRowLoading,
  orphanBandRow,
  summaryBandRows,
  workerBandRow,
} from "./summaryBand.ts";

const NOW = Date.parse("2026-10-26T03:00:00.000Z");
const FETCHED = Date.parse("2026-10-26T02:58:00.000Z");
const FUTURE = "2026-10-26T04:00:00.000Z";
const PAST = "2026-10-26T02:00:00.000Z";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function loaded<T>(data: T): BandSource<T> {
  return { data, isError: false, updatedAt: FETCHED };
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

const MIB = 1024 * 1024;

const WORKER_LOAD: WorkerLoad = {
  window_hours: 24,
  sample_count: 700,
  expected_count: 720,
  latest: {
    sampled_at: PAST,
    slots: 3,
    running_jobs: 1,
    waiting_jobs: 0,
    max_wait_seconds: 0,
    lag_seconds: 1,
    mem_current_bytes: 309 * MIB,
    mem_anon_bytes: 76 * MIB,
    mem_working_set_bytes: 261 * MIB,
    mem_peak_bytes: 1307 * MIB,
    mem_limit_bytes: 4096 * MIB,
  },
  max: {
    running_jobs: 2,
    waiting_jobs: 3,
    max_wait_seconds: 45,
    lag_seconds: 12,
    mem_current_bytes: 400 * MIB,
    mem_anon_bytes: 172 * MIB,
    mem_anon_ratio: 0.042,
    mem_working_set_bytes: 190 * MIB,
    mem_peak_bytes: 1307 * MIB,
  },
  running_readable_samples: 690,
  busy_samples: 7,
  lag_over_samples: 10,
};

function status(overrides: Partial<SystemStatus> = {}): SystemStatus {
  return {
    deployed_sha: SHA_B,
    deployment: DEPLOYMENT,
    fetcher: FETCHER_OK,
    orphan_failures: [],
    info_notices: [],
    resolved_notices: [],
    worker_load: WORKER_LOAD,
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

function summary(
  failures: SummaryFailure[],
  auditFailuresOpen?: number,
): ConsoleSummary {
  return {
    counts: {
      approvals: 0,
      failures: failures.length,
      notices: 0,
      ...(auditFailuresOpen === undefined
        ? {}
        : { audit_failures_open: auditFailuresOpen }),
    },
    approvals: [],
    failures,
    notices: [],
  };
}

const LOADING = { data: undefined, isError: false, updatedAt: 0 };
const FAILED = { data: undefined, isError: true, updatedAt: 0 };

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

describe("holdsBandRow", () => {
  test("is normal when nothing is held", () => {
    expect(holdsBandRow(loaded(NO_HOLDS), NOW).level).toBe("normal");
  });

  test("states that nothing is held", () => {
    expect(holdsBandRow(loaded(NO_HOLDS), NOW).text).toBe(
      "有効な保留と凍結はありません",
    );
  });

  test("counts zero active holds", () => {
    expect(holdsBandRow(loaded(NO_HOLDS), NOW).count).toBe(0);
  });

  test("is a caution for one active hold", () => {
    expect(holdsBandRow(loaded(holdsWith([holdRow(FUTURE)])), NOW).level).toBe(
      "caution",
    );
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
    expect(holdsBandRow(loaded(data), NOW).count).toBe(3);
  });

  test("states the active count", () => {
    expect(
      holdsBandRow(
        loaded(holdsWith([holdRow(FUTURE), holdRow(FUTURE, 2)])),
        NOW,
      ).text,
    ).toBe("有効な保留と凍結が2件あります");
  });

  test("needs action when a hold has expired", () => {
    expect(holdsBandRow(loaded(holdsWith([holdRow(PAST)])), NOW).level).toBe(
      "action",
    );
  });

  test("needs action for an expired hold even next to an active one", () => {
    expect(
      holdsBandRow(loaded(holdsWith([holdRow(PAST), holdRow(FUTURE, 2)])), NOW)
        .level,
    ).toBe("action");
  });

  test("states the expired and active counts", () => {
    expect(
      holdsBandRow(loaded(holdsWith([holdRow(PAST), holdRow(FUTURE, 2)])), NOW)
        .text,
    ).toBe("期限切れ1件、有効1件");
  });

  test("needs action when the holds table cannot be read", () => {
    const data: HoldsSnapshot = {
      ...NO_HOLDS,
      holds: { ok: false, kind: "read_failed", reason: "boom" },
    };
    expect(holdsBandRow(loaded(data), NOW).level).toBe("action");
  });

  test("names the holds table when only it cannot be read", () => {
    const data: HoldsSnapshot = {
      ...NO_HOLDS,
      holds: { ok: false, kind: "read_failed", reason: "boom" },
    };
    expect(holdsBandRow(loaded(data), NOW).text).toBe("保留の表を読めません");
  });

  test("needs action when the freezes cannot be read", () => {
    const data: HoldsSnapshot = {
      ...NO_HOLDS,
      freezes: { ok: false, reason: "boom" },
    };
    expect(holdsBandRow(loaded(data), NOW).level).toBe("action");
  });

  test("names the freezes when only they cannot be read", () => {
    const data: HoldsSnapshot = {
      ...NO_HOLDS,
      freezes: { ok: false, reason: "boom" },
    };
    expect(holdsBandRow(loaded(data), NOW).text).toBe("凍結の変数を読めません");
  });

  test("names both when neither can be read", () => {
    const data: HoldsSnapshot = {
      holds: { ok: false, kind: "corrupt", reason: "boom" },
      freezes: { ok: false, reason: "boom" },
    };
    expect(holdsBandRow(loaded(data), NOW).text).toBe("保留と凍結を読めません");
  });

  test("has no count when a source cannot be read", () => {
    const data: HoldsSnapshot = {
      ...NO_HOLDS,
      freezes: { ok: false, reason: "boom" },
    };
    expect(holdsBandRow(loaded(data), NOW).count).toBeNull();
  });

  test("is undecided while loading", () => {
    expect(holdsBandRow(LOADING, NOW).level).toBe("none");
  });

  test("says it is loading", () => {
    expect(holdsBandRow(LOADING, NOW).text).toBe("取得中です");
  });

  test("is undecided when the fetch failed", () => {
    expect(holdsBandRow(FAILED, NOW).level).toBe("none");
  });

  test("says the fetch failed", () => {
    expect(holdsBandRow(FAILED, NOW).text).toBe("取得できませんでした");
  });

  test("keeps the previous values when a refetch failed", () => {
    expect(
      holdsBandRow(
        { ...loaded(holdsWith([holdRow(FUTURE)])), isError: true },
        NOW,
      ).level,
    ).toBe("caution");
  });

  test("points at the holds section of the status tab", () => {
    const row = holdsBandRow(loaded(NO_HOLDS), NOW);
    expect([row.tab, row.targetId]).toEqual(["status", "holds-heading"]);
  });

  test("carries the time of its fetch", () => {
    expect(holdsBandRow(loaded(NO_HOLDS), NOW).updatedAt).toBe(FETCHED);
  });
});

describe("deploymentBandRow", () => {
  test("is normal for a success", () => {
    expect(deploymentBandRow(loaded(status())).level).toBe("normal");
  });

  test("is a caution for a success that needs host action", () => {
    expect(
      deploymentBandRow(
        loaded(
          status({ deployment: { ...DEPLOYMENT, needs_host_action: true } }),
        ),
      ).level,
    ).toBe("caution");
  });

  test("needs action for a failure", () => {
    expect(
      deploymentBandRow(
        loaded(status({ deployment: { ...DEPLOYMENT, result: "failed" } })),
      ).level,
    ).toBe("action");
  });

  test("needs action for a failure that also needs host action", () => {
    expect(
      deploymentBandRow(
        loaded(
          status({
            deployment: {
              ...DEPLOYMENT,
              result: "failed",
              needs_host_action: true,
            },
          }),
        ),
      ).level,
    ).toBe("action");
  });

  test("needs action for a result it does not know", () => {
    expect(
      deploymentBandRow(
        loaded(status({ deployment: { ...DEPLOYMENT, result: "weird" } })),
      ).level,
    ).toBe("action");
  });

  test("is undecided without a record", () => {
    expect(deploymentBandRow(loaded(status({ deployment: null }))).level).toBe(
      "none",
    );
  });

  test("says there is no record", () => {
    expect(deploymentBandRow(loaded(status({ deployment: null }))).text).toBe(
      "記録なし",
    );
  });

  test("states a success", () => {
    expect(deploymentBandRow(loaded(status())).text).toBe("直近の反映は成功");
  });

  test("states the host action next to a success", () => {
    expect(
      deploymentBandRow(
        loaded(
          status({ deployment: { ...DEPLOYMENT, needs_host_action: true } }),
        ),
      ).text,
    ).toBe("直近の反映は成功。ホストの作業が必要");
  });

  test("states a failure", () => {
    expect(
      deploymentBandRow(
        loaded(status({ deployment: { ...DEPLOYMENT, result: "failed" } })),
      ).text,
    ).toBe("直近の反映は失敗");
  });

  test("states both a failure and the host action", () => {
    expect(
      deploymentBandRow(
        loaded(
          status({
            deployment: {
              ...DEPLOYMENT,
              result: "failed",
              needs_host_action: true,
            },
          }),
        ),
      ).text,
    ).toBe("直近の反映は失敗。ホストの作業も必要");
  });

  test("is undecided while loading", () => {
    expect(deploymentBandRow(LOADING).level).toBe("none");
  });

  test("points at the release section of the status tab", () => {
    const row = deploymentBandRow(loaded(status()));
    expect([row.tab, row.targetId]).toEqual(["status", "release-heading"]);
  });

  test("carries the time of its fetch", () => {
    expect(deploymentBandRow(loaded(status())).updatedAt).toBe(FETCHED);
  });
});

describe("fetcherBandRow", () => {
  test("is normal for a fetch that is up to date", () => {
    expect(fetcherBandRow(loaded(status())).level).toBe("normal");
  });

  test("needs action for a failed fetch", () => {
    expect(
      fetcherBandRow(
        loaded(status({ fetcher: { ...FETCHER_OK, state: "failed" } })),
      ).level,
    ).toBe("action");
  });

  test("needs action when the judgment itself is a failure", () => {
    expect(
      fetcherBandRow(
        loaded(status({ fetcher: { ...FETCHER_OK, assessment: "failed" } })),
      ).level,
    ).toBe("action");
  });

  test("is a caution for a pinned version", () => {
    expect(
      fetcherBandRow(
        loaded(status({ fetcher: { ...FETCHER_OK, state: "pinned" } })),
      ).level,
    ).toBe("caution");
  });

  test("is a caution for a stale record", () => {
    expect(
      fetcherBandRow(
        loaded(status({ fetcher: { ...FETCHER_OK, assessment: "stale" } })),
      ).level,
    ).toBe("caution");
  });

  test("is a caution when the status file cannot be read", () => {
    expect(
      fetcherBandRow(
        loaded(
          status({
            fetcher: { availability: "unavailable", reason: "missing" },
          }),
        ),
      ).level,
    ).toBe("caution");
  });

  test("uses the label of the fetch as the text", () => {
    expect(fetcherBandRow(loaded(status())).text).toBe("取り込み済み");
  });

  test("says the state cannot be read", () => {
    expect(
      fetcherBandRow(
        loaded(
          status({
            fetcher: { availability: "unavailable", reason: "missing" },
          }),
        ),
      ).text,
    ).toBe("状態を読めません");
  });

  test("is undecided while loading", () => {
    expect(fetcherBandRow(LOADING).level).toBe("none");
  });

  test("points at the release section of the status tab", () => {
    const row = fetcherBandRow(loaded(status()));
    expect([row.tab, row.targetId]).toEqual(["status", "release-heading"]);
  });
});

describe("auditBandRow", () => {
  test("is normal without an open failure", () => {
    expect(auditBandRow(loaded(summary([], 0))).level).toBe("normal");
  });

  test("is a caution for one open failure", () => {
    expect(
      auditBandRow(loaded(summary([auditFailure(1, false)], 1))).level,
    ).toBe("caution");
  });

  test("shows the open count in words", () => {
    expect(
      auditBandRow(loaded(summary([auditFailure(1, false)], 1))).text,
    ).toBe("未解決の失敗が1件あります");
  });

  test("has the open count as its count", () => {
    expect(
      auditBandRow(loaded(summary([auditFailure(1, false)], 3))).count,
    ).toBe(3);
  });

  test("uses the open count from the backend over the listed rows", () => {
    expect(
      auditBandRow(
        loaded(summary([auditFailure(1, false), auditFailure(2, true)], 1)),
      ).count,
    ).toBe(1);
  });

  test("counts every audit failure when the backend sends no open count", () => {
    expect(
      auditBandRow(
        loaded(
          summary([
            auditFailure(1),
            auditFailure(2, true),
            auditFailure(3, false, "issue"),
          ]),
        ),
      ).count,
    ).toBe(2);
  });

  test("is normal when every failure was reported by a later audit", () => {
    expect(
      auditBandRow(loaded(summary([auditFailure(1, true)], 0))).level,
    ).toBe("normal");
  });

  test("is undecided while loading", () => {
    expect(auditBandRow(LOADING).level).toBe("none");
  });

  test("points at the audit failures of the failures tab", () => {
    const row = auditBandRow(loaded(summary([], 0)));
    expect([row.tab, row.targetId]).toEqual([
      "failures",
      "audit-failures-heading",
    ]);
  });

  test("carries the time of the summary fetch", () => {
    expect(auditBandRow(loaded(summary([], 0))).updatedAt).toBe(FETCHED);
  });
});

describe("infoBandRow and orphanBandRow", () => {
  const FIVE = Array.from({ length: 5 }, (_, index) => ({
    ...ORPHAN,
    job_failure_id: index + 1,
  }));

  test("count the unresolved info notices without judging them", () => {
    const notice = {
      notice_id: 1,
      kind: "info_deploy_done",
      message: "m",
      resolved: false,
      created_at: PAST,
      severity: "info",
      resolvable: true,
    };
    const row = infoBandRow(loaded(status({ info_notices: [notice] })));
    expect([row.level, row.count, row.text]).toEqual(["none", 1, "1件"]);
  });

  test("count the failures without a work item without judging them", () => {
    const row = orphanBandRow(loaded(status({ orphan_failures: FIVE })));
    expect([row.level, row.count, row.text]).toEqual(["none", 5, "5件"]);
  });

  test("show zero as a count", () => {
    expect(orphanBandRow(loaded(status())).text).toBe("0件");
  });

  test("add no note below the limit", () => {
    expect(
      orphanBandRow(loaded(status({ orphan_failures: FIVE }))).note,
    ).toBeNull();
  });

  test("add the limit note at the limit", () => {
    const atLimit = Array.from({ length: 200 }, (_, index) => ({
      ...ORPHAN,
      job_failure_id: index + 1,
    }));
    expect(
      orphanBandRow(loaded(status({ orphan_failures: atLimit }))).note,
    ).toBe(
      "200件に達したので、これより古いものは表示していない場合があります。",
    );
  });

  test("point at their own sections of the failures tab", () => {
    expect([
      infoBandRow(loaded(status())).targetId,
      orphanBandRow(loaded(status())).targetId,
    ]).toEqual(["info-notices-heading", "orphan-failures-heading"]);
  });

  test("are undecided while loading", () => {
    expect([infoBandRow(LOADING).text, orphanBandRow(LOADING).text]).toEqual([
      "取得中です",
      "取得中です",
    ]);
  });
});

describe("workerBandRow", () => {
  test("never judges the load", () => {
    expect(workerBandRow(loaded(status())).level).toBe("none");
  });

  test("shows the busy samples", () => {
    expect(workerBandRow(loaded(status())).text).toContain(
      "枠が塞がっていた記録7件",
    );
  });

  test("shows the late samples", () => {
    expect(workerBandRow(loaded(status())).text).toContain(
      "開始が遅れた記録10件",
    );
  });

  test("shows the largest memory share", () => {
    expect(workerBandRow(loaded(status())).text).toContain("メモリの最大4%");
  });

  test("shows how many samples were recorded", () => {
    expect(workerBandRow(loaded(status())).text).toContain("記録700/720件");
  });

  test("says there is no record without a load", () => {
    expect(workerBandRow(loaded(status({ worker_load: null }))).text).toBe(
      "記録なし",
    );
  });

  test("says there is no record for a load from an older backend", () => {
    const { worker_load: _omitted, ...older } = status();
    expect(workerBandRow(loaded(older)).text).toBe("記録なし");
  });

  test("says there is no record for a load of a different shape", () => {
    expect(
      workerBandRow(loaded(status({ worker_load: { sample_count: "x" } })))
        .text,
    ).toBe("記録なし");
  });

  test("points at the worker load of the status tab", () => {
    const row = workerBandRow(loaded(status()));
    expect([row.tab, row.targetId]).toEqual(["status", "worker-load-heading"]);
  });
});

describe("summaryBandRows", () => {
  const SOURCES = {
    holds: loaded(NO_HOLDS),
    status: loaded(status()),
    summary: loaded(summary([], 0)),
  };

  test("lists the rows in the order of the screen", () => {
    expect(summaryBandRows(SOURCES, NOW).map((row) => row.id)).toEqual([
      "holds",
      "deployment",
      "fetcher",
      "audit",
      "info",
      "orphan",
      "worker",
    ]);
  });

  test("gives every row a label", () => {
    expect(
      summaryBandRows(SOURCES, NOW).every((row) => row.label.length > 0),
    ).toBe(true);
  });

  test("gives each row the time of its own fetch", () => {
    const rows = summaryBandRows(
      {
        holds: { ...loaded(NO_HOLDS), updatedAt: 1 },
        status: { ...loaded(status()), updatedAt: 2 },
        summary: { ...loaded(summary([], 0)), updatedAt: 3 },
      },
      NOW,
    );
    expect(rows.map((row) => row.updatedAt)).toEqual([1, 2, 2, 3, 2, 2, 2]);
  });
});

describe("isBandRowLoading", () => {
  test("is true for a row whose fetch has not returned", () => {
    expect(isBandRowLoading(holdsBandRow(LOADING, NOW))).toBe(true);
  });

  test("is false for a row whose fetch failed", () => {
    expect(isBandRowLoading(holdsBandRow(FAILED, NOW))).toBe(false);
  });

  test("is false for a row with a value", () => {
    expect(isBandRowLoading(holdsBandRow(loaded(NO_HOLDS), NOW))).toBe(false);
  });

  test("is false for a row that has no judgment but has a value", () => {
    expect(isBandRowLoading(workerBandRow(loaded(status())))).toBe(false);
  });

  test("uses the words of the loading row", () => {
    expect(holdsBandRow(LOADING, NOW).text).toBe(BAND_LOADING_TEXT);
  });
});
