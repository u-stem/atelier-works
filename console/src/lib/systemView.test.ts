import { describe, expect, test } from "bun:test";
import type { SummaryFailure, SummaryNotice } from "../api/guards/summary.ts";
import type {
  SystemDeployment,
  SystemFetcher,
  SystemOrphanFailure,
  SystemResolvedNotice,
} from "../api/guards/systemStatus.ts";
import {
  auditFailureLimitNote,
  auditFailuresOf,
  describeFetcher,
  describeInfoNotice,
  describeLatestDeployment,
  describeOrphanFailure,
  describeResolvedNotice,
  FETCHER_STALE_MINUTES,
  listLimitNote,
  messagePreview,
  noticeDetailPath,
  resolverLabel,
} from "./systemView.ts";

const T0 = "2026-10-08T00:00:00.000Z";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const JOB = "0190a8e0-1111-4222-8333-444455556666";

const FETCHER_OK: Extract<SystemFetcher, { availability: "available" }> = {
  availability: "available",
  state: "ok",
  sha: SHA,
  checked_at: T0,
  error: null,
  assessment: "ok",
  minutes_since_check: 2,
  next_action: null,
};

describe("describeFetcher", () => {
  test("reports an unreadable status file as a warning", () => {
    expect(
      describeFetcher({ availability: "unavailable", reason: "missing" }).tone,
    ).toBe("warning");
  });

  test("names the reason a status file is unreadable", () => {
    expect(
      describeFetcher({ availability: "unavailable", reason: "invalid" })
        .detail,
    ).toBe("取り込みの状態のファイルの形式が正しくありません。");
  });

  test("reports a healthy fetcher as success", () => {
    expect(describeFetcher(FETCHER_OK).tone).toBe("success");
  });

  test("labels a healthy fetcher", () => {
    expect(describeFetcher(FETCHER_OK).label).toBe("取り込み済み");
  });

  test("shortens the fetched version", () => {
    expect(describeFetcher(FETCHER_OK).versionLabel).toBe("0123456");
  });

  test("reports a failed assessment as a failure", () => {
    expect(
      describeFetcher({ ...FETCHER_OK, state: "failed", assessment: "failed" })
        .tone,
    ).toBe("failure");
  });

  test("reports a stale assessment as a warning", () => {
    expect(describeFetcher({ ...FETCHER_OK, assessment: "stale" }).tone).toBe(
      "warning",
    );
  });

  test("marks the label of a stale record", () => {
    expect(describeFetcher({ ...FETCHER_OK, assessment: "stale" }).label).toBe(
      "取り込み済み(古い記録)",
    );
  });

  test("states the stale threshold in the explanation", () => {
    expect(FETCHER_STALE_MINUTES).toBe(30);
  });

  test("explains a stale assessment", () => {
    expect(describeFetcher({ ...FETCHER_OK, assessment: "stale" }).detail).toBe(
      "30分以上、取り込みの結果が更新されていません。",
    );
  });

  test("reports a pinned version as a warning", () => {
    expect(describeFetcher({ ...FETCHER_OK, state: "pinned" }).tone).toBe(
      "warning",
    );
  });

  test("labels a pinned version", () => {
    expect(describeFetcher({ ...FETCHER_OK, state: "pinned" }).label).toBe(
      "版を固定中",
    );
  });

  test("treats an assessment that is not known yet as a warning", () => {
    expect(
      describeFetcher({ ...FETCHER_OK, assessment: "degraded" }).tone,
    ).toBe("warning");
  });

  test("passes the next action through", () => {
    expect(
      describeFetcher({ ...FETCHER_OK, next_action: "ログを見る" }).nextAction,
    ).toBe("ログを見る");
  });

  test("replaces hidden characters in the error code", () => {
    expect(describeFetcher({ ...FETCHER_OK, error: "a‮b" }).errorCode).toBe(
      "a�b",
    );
  });

  test("leaves the version out when the fetcher has none", () => {
    expect(describeFetcher({ ...FETCHER_OK, sha: null }).versionLabel).toBe(
      null,
    );
  });
});

const DEPLOYMENT: SystemDeployment = {
  sha_from: null,
  sha_to: SHA,
  changed_paths: ["a", "b"],
  result: "success",
  needs_host_action: true,
  occurred_at: T0,
};

describe("describeLatestDeployment", () => {
  test("writes the first deployment as from the initial state", () => {
    expect(describeLatestDeployment(DEPLOYMENT).versionLabel).toBe(
      "初回 → 0123456",
    );
  });

  test("labels the result in Japanese", () => {
    expect(describeLatestDeployment(DEPLOYMENT).resultLabel).toBe("反映済み");
  });

  test("marks a failed deployment as a failure", () => {
    expect(
      describeLatestDeployment({ ...DEPLOYMENT, result: "failed" }).resultTone,
    ).toBe("failure");
  });

  test("marks a deployment that needs host work as a warning", () => {
    expect(describeLatestDeployment(DEPLOYMENT).hostActionTone).toBe("warning");
  });

  test("counts the changed paths", () => {
    expect(describeLatestDeployment(DEPLOYMENT).changedPathCount).toBe(2);
  });
});

const INFO: SummaryNotice = {
  notice_id: 31,
  kind: "claim_race_lost",
  message: "first line\nsecond line",
  resolved: false,
  created_at: T0,
  severity: "info",
  resolvable: true,
};

describe("noticeDetailPath", () => {
  test("points at the inbox with the notice selected", () => {
    expect(noticeDetailPath(31)).toBe("/?notice=31");
  });
});

describe("messagePreview", () => {
  test("keeps only the first non-empty line", () => {
    expect(messagePreview("\n\nfirst\nsecond", 50)).toBe("first");
  });

  test("clips a long line with an ellipsis", () => {
    expect(messagePreview("abcdefghij", 5)).toBe("abcde…");
  });

  test("counts a surrogate pair as one character", () => {
    expect(messagePreview("😀😀😀", 2)).toBe("😀😀…");
  });

  test("returns an empty text for an empty message", () => {
    expect(messagePreview("", 5)).toBe("");
  });
});

describe("describeInfoNotice", () => {
  test("names the kind in Japanese", () => {
    expect(describeInfoNotice(INFO).title).toBe("着手の競合");
  });

  test("previews the first line of the message", () => {
    expect(describeInfoNotice(INFO).preview).toBe("first line");
  });

  test("links to the inbox detail", () => {
    expect(describeInfoNotice(INFO).href).toBe("/?notice=31");
  });

  test("tells whether the detail can resolve the notice", () => {
    expect(describeInfoNotice({ ...INFO, resolvable: false }).canResolve).toBe(
      false,
    );
  });

  test("replaces hidden characters in the preview", () => {
    expect(describeInfoNotice({ ...INFO, message: "a​b" }).preview).toBe("a�b");
  });
});

const RESOLVED: SystemResolvedNotice = {
  notice_id: 32,
  kind: "cleanup_db_failed",
  message: "fixed\nmore",
  created_at: T0,
  resolved_by: "cleanup_db",
  resolved_at: "2026-10-08T01:00:00.000Z",
};

describe("resolverLabel", () => {
  test("labels the database cleanup as automatic", () => {
    expect(resolverLabel("cleanup_db")).toBe("DBの掃除(自動)");
  });

  test("labels the workspace cleanup as automatic", () => {
    expect(resolverLabel("cleanup_workspaces")).toBe("作業領域の掃除(自動)");
  });

  test("labels the self update as automatic", () => {
    expect(resolverLabel("self_update")).toBe("自己更新(自動)");
  });

  test("labels the issue poller as automatic", () => {
    expect(resolverLabel("poll_issues")).toBe("Issueの取得(自動)");
  });

  test("labels the pull request poller as automatic", () => {
    expect(resolverLabel("poll_prs")).toBe("PRの取得(自動)");
  });

  test("labels the main CI watcher as automatic", () => {
    expect(resolverLabel("watch_main_ci")).toBe("mainのCIの監視(自動)");
  });

  test("labels the pull request CI watcher as automatic", () => {
    expect(resolverLabel("watch_pr_ci")).toBe("PRのCIの監視(自動)");
  });

  test("labels the pull request conflict watcher as automatic", () => {
    expect(resolverLabel("watch_pr_conflicts")).toBe("PRの競合の監視(自動)");
  });

  test("shows a person's name as plain text", () => {
    expect(resolverLabel("operator")).toBe("operator");
  });

  test("says there is no record when the resolver is unknown", () => {
    expect(resolverLabel(null)).toBe("記録なし");
  });

  test("replaces hidden characters in a name", () => {
    expect(resolverLabel("a‮b")).toBe("a�b");
  });
});

describe("describeResolvedNotice", () => {
  test("keeps the whole message", () => {
    expect(describeResolvedNotice(RESOLVED).message).toBe("fixed\nmore");
  });

  test("uses the resolution time when it is recorded", () => {
    expect(describeResolvedNotice(RESOLVED).resolvedAt).toBe(
      "2026-10-08T01:00:00.000Z",
    );
  });

  test("leaves the resolution time empty when it is not recorded", () => {
    expect(
      describeResolvedNotice({ ...RESOLVED, resolved_at: null }).resolvedAt,
    ).toBe(null);
  });

  test("marks a message cut at the limit", () => {
    expect(
      describeResolvedNotice({ ...RESOLVED, message: "x".repeat(500) })
        .truncated,
    ).toBe(true);
  });

  test("does not mark a short message as cut", () => {
    expect(describeResolvedNotice(RESOLVED).truncated).toBe(false);
  });

  test("shows the resolver", () => {
    expect(describeResolvedNotice(RESOLVED).resolver).toBe("DBの掃除(自動)");
  });
});

const ORPHAN: SystemOrphanFailure = {
  job_failure_id: 8,
  flow_path: "f/factory/poll_issues",
  job_id: JOB,
  step: "fetch",
  error: "boom",
  occurred_at: T0,
};

describe("describeOrphanFailure", () => {
  test("joins the flow and the step", () => {
    expect(describeOrphanFailure(ORPHAN).flowLabel).toBe(
      "f/factory/poll_issues / fetch",
    );
  });

  test("shows only the flow when there is no step", () => {
    expect(describeOrphanFailure({ ...ORPHAN, step: null }).flowLabel).toBe(
      "f/factory/poll_issues",
    );
  });

  test("keeps a job id that has the shape of a job id", () => {
    expect(describeOrphanFailure(ORPHAN).jobId).toBe(JOB);
  });

  test("drops a job id that is not a job id", () => {
    expect(describeOrphanFailure({ ...ORPHAN, job_id: "job-9" }).jobId).toBe(
      null,
    );
  });

  test("marks an error as cut when it reaches the summary limit", () => {
    expect(
      describeOrphanFailure({ ...ORPHAN, error: "x".repeat(500) }).error
        .truncated,
    ).toBe(true);
  });

  test("does not mark a short error as cut", () => {
    expect(describeOrphanFailure(ORPHAN).error.truncated).toBe(false);
  });

  test("replaces hidden characters in the error", () => {
    expect(describeOrphanFailure({ ...ORPHAN, error: "a‮b" }).error.text).toBe(
      "a�b",
    );
  });
});

function failure(kind: string, id: number): SummaryFailure {
  return {
    work_item_id: id,
    kind,
    owner: "o",
    repo: "r",
    issue_number: null,
    issue_url: null,
    pr_number: null,
    title: null,
    status: "failed",
    updated_at: T0,
    status_note: null,
    status_changed_at: null,
    job_failure_id: null,
    flow_path: null,
    job_id: null,
    step: null,
    error: null,
    occurred_at: null,
  };
}

describe("auditFailuresOf", () => {
  test("keeps only the audit failures", () => {
    expect(
      auditFailuresOf([failure("issue", 1), failure("audit", 2)]).map(
        (row) => row.work_item_id,
      ),
    ).toEqual([2]);
  });

  test("returns an empty list when no audit failed", () => {
    expect(auditFailuresOf([failure("issue", 1)])).toEqual([]);
  });

  test("keeps the order of the summary", () => {
    expect(
      auditFailuresOf([failure("audit", 3), failure("audit", 2)]).map(
        (row) => row.work_item_id,
      ),
    ).toEqual([3, 2]);
  });
});

describe("listLimitNote", () => {
  test("is empty below the limit", () => {
    expect(listLimitNote(199, 200)).toBe(null);
  });

  test("warns that older entries may be missing at the limit", () => {
    expect(listLimitNote(200, 200)).toBe(
      "200件に達したので、これより古いものは表示していない場合があります。",
    );
  });
});

describe("auditFailureLimitNote", () => {
  test("is empty when every failure is listed", () => {
    expect(auditFailureLimitNote({ counts: 2, listed: 2 })).toBe(null);
  });

  test("warns that older audit failures may be missing", () => {
    expect(auditFailureLimitNote({ counts: 3, listed: 2 })).toContain(
      "古い監査の失敗は表示していない場合があります。",
    );
  });

  test("explains why the count in the inbox may be larger than this list", () => {
    expect(auditFailureLimitNote({ counts: 3, listed: 2 })).toContain(
      "要対応の「監査の失敗」の件数は、表示していない分も数えるので、この一覧より多いことがあります。",
    );
  });

  test("gives no explanation about the count when the list is complete", () => {
    expect(auditFailureLimitNote({ counts: 2, listed: 2 })).toBeNull();
  });
});
