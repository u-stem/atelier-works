import { describe, expect, test } from "bun:test";
import type { JobDetailView, JobSummaryView } from "../api/jobsQueries.ts";
import {
  describePrReviewResult,
  offersRetry,
  type PrReviewResultState,
  prReviewResultState,
} from "./prReviewResult.ts";

type Found = Extract<JobDetailView, { found: true }>;

const JOB_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

function job(state: string): JobSummaryView {
  return {
    id: JOB_ID,
    state,
    script_path: "f/factory/pr_review_intake",
    job_kind: "flow",
    created_at: "2026-11-02T01:00:00.000Z",
    started_at: null,
    completed_at: null,
    scheduled_for: null,
    duration_ms: null,
    schedule_path: null,
    parent_job: null,
    tag: "console",
    is_flow_step: false,
  };
}

function output(
  text: string,
  over: { truncated?: boolean; masked?: boolean } = {},
) {
  return { text, truncated: false, masked: false, ...over };
}

function detail(
  state: string,
  over: Partial<Pick<Found, "result" | "result_error">> = {},
): Found {
  return {
    found: true,
    job: job(state),
    args: [],
    steps: [],
    log: null,
    result: null,
    result_error: null,
    failures: { ok: true, items: [] },
    ...over,
  };
}

const STARTED = JSON.stringify({
  status: "started",
  work_item_id: 41,
  flow_job_id: JOB_ID,
});

const REFUSED = JSON.stringify({ status: "refused", reason: "pr_closed" });

type Reads = {
  data?: JobDetailView | undefined;
  isError?: boolean;
  statusData?: JobDetailView | undefined;
  /** 状態の取得を、結果つきの取得より新しい読み取りにするか。 */
  statusNewer?: boolean;
};

function stateOf(reads: Reads): PrReviewResultState {
  return prReviewResultState({
    output: {
      data: reads.data,
      updatedAt: 1000,
      isError: reads.isError ?? false,
    },
    status: {
      data: reads.statusData,
      updatedAt: reads.statusNewer === true ? 2000 : 0,
    },
  });
}

function kindOf(reads: Reads): string {
  return stateOf(reads).kind;
}

describe("row 1: the read failed", () => {
  test("says the result is unavailable when the first read failed", () => {
    expect(kindOf({ isError: true })).toBe("unavailable");
  });

  test("says the result is unavailable when a re-read failed and old data remains", () => {
    expect(kindOf({ data: detail("running"), isError: true })).toBe(
      "unavailable",
    );
  });

  test("puts the failed read before a result that would otherwise be shown", () => {
    expect(
      kindOf({
        data: detail("success", { result: output(STARTED) }),
        isError: true,
      }),
    ).toBe("unavailable");
  });
});

describe("row 2: the result could not be read", () => {
  test("says the result is unavailable when the server reports a result error", () => {
    expect(
      kindOf({ data: detail("success", { result_error: "timeout" }) }),
    ).toBe("unavailable");
  });

  test("puts the result error before a failed job", () => {
    expect(
      kindOf({ data: detail("failure", { result_error: "timeout" }) }),
    ).toBe("unavailable");
  });
});

describe("row 3: the result cannot be understood", () => {
  test("says the result is unreadable when the job was not found", () => {
    expect(kindOf({ data: { found: false } })).toBe("unreadable");
  });

  test("says the result is unreadable when the result was truncated", () => {
    expect(
      kindOf({
        data: detail("success", {
          result: output(STARTED, { truncated: true }),
        }),
      }),
    ).toBe("unreadable");
  });

  test("says the result is unreadable when the result was masked", () => {
    expect(
      kindOf({
        data: detail("success", { result: output(STARTED, { masked: true }) }),
      }),
    ).toBe("unreadable");
  });

  test("says the result is unreadable when the result is not JSON", () => {
    expect(
      kindOf({ data: detail("success", { result: output("not json") }) }),
    ).toBe("unreadable");
  });

  test("says the result is unreadable when the result is not a register result", () => {
    expect(
      kindOf({
        data: detail("success", {
          result: output(JSON.stringify({ status: "queued" })),
        }),
      }),
    ).toBe("unreadable");
  });

  test("says the result is unreadable when the refusal reason is unknown", () => {
    expect(
      kindOf({
        data: detail("success", {
          result: output(
            JSON.stringify({ status: "refused", reason: "something_new" }),
          ),
        }),
      }),
    ).toBe("unreadable");
  });

  test.each(["failure", "canceled", "skipped"])(
    "says the result is unreadable when the job ended as %s",
    (state) => {
      expect(kindOf({ data: detail(state) })).toBe("unreadable");
    },
  );

  test("says the result is unreadable when the finished job has no result", () => {
    expect(kindOf({ data: detail("success") })).toBe("unreadable");
  });

  test("says the result is unreadable when the newer status already shows a failure", () => {
    expect(
      kindOf({
        data: detail("running"),
        statusData: detail("failure"),
        statusNewer: true,
      }),
    ).toBe("unreadable");
  });
});

describe("row 4: the result is not there yet", () => {
  test("waits for the first read", () => {
    expect(kindOf({})).toBe("waiting");
  });

  test.each(["queued", "running", "scheduled", "waiting_for_something_new"])(
    "waits while the job is %s",
    (state) => {
      expect(kindOf({ data: detail(state) })).toBe("waiting");
    },
  );

  test("waits for the output to be read again after the status saw the job finish", () => {
    expect(
      kindOf({
        data: detail("running"),
        statusData: detail("success"),
        statusNewer: true,
      }),
    ).toBe("waiting");
  });

  test("keeps a finished job's result when an older status shows it running", () => {
    expect(
      kindOf({
        data: detail("success", { result: output(STARTED) }),
        statusData: detail("running"),
        statusNewer: true,
      }),
    ).toBe("started");
  });
});

describe("row 5: the review started", () => {
  test("shows the review as started", () => {
    expect(
      stateOf({ data: detail("success", { result: output(STARTED) }) }),
    ).toEqual({ kind: "started", workItemId: 41 });
  });
});

describe("row 6: the review was refused", () => {
  test("shows the refusal reason", () => {
    expect(
      stateOf({ data: detail("success", { result: output(REFUSED) }) }),
    ).toEqual({ kind: "refused", reason: "pr_closed" });
  });
});

describe("the retry operation", () => {
  test.each([
    [{ kind: "unavailable" }, true],
    [{ kind: "unreadable" }, false],
    [{ kind: "waiting" }, false],
    [{ kind: "started", workItemId: 41 }, false],
    [{ kind: "refused", reason: "pr_closed" }, false],
  ] as const)("for %j offers a retry: %p", (state, expected) => {
    expect(offersRetry(state)).toBe(expected);
  });
});

describe("the wording", () => {
  test("says the result is awaited", () => {
    expect(describePrReviewResult({ kind: "waiting" }).headline).toBe(
      "結果を待っています",
    );
  });

  test("says the result cannot be fetched", () => {
    expect(describePrReviewResult({ kind: "unavailable" }).headline).toBe(
      "結果を取得できません",
    );
  });

  test("says the result cannot be read and points to the job", () => {
    expect(describePrReviewResult({ kind: "unreadable" }).headline).toBe(
      "結果を読み取れません。ジョブを開いて確認してください",
    );
  });

  test("says the review started", () => {
    expect(
      describePrReviewResult({ kind: "started", workItemId: 41 }).headline,
    ).toBe("レビューを始めました");
  });

  test("words the refusal with the fixed sentence of the register step", () => {
    expect(
      describePrReviewResult({ kind: "refused", reason: "pr_closed" }).headline,
    ).toContain("フローは動きましたが、レビューは始まっていません。");
  });

  test.each([
    ["waiting", "default"],
    ["unavailable", "error"],
    ["unreadable", "warning"],
  ] as const)("marks %s with the tone %s", (kind, tone) => {
    expect(describePrReviewResult({ kind }).tone).toBe(tone);
  });

  test("marks a started review with the default tone", () => {
    expect(
      describePrReviewResult({ kind: "started", workItemId: 41 }).tone,
    ).toBe("default");
  });

  test("marks a refusal as an error", () => {
    expect(
      describePrReviewResult({ kind: "refused", reason: "pr_closed" }).tone,
    ).toBe("error");
  });
});
