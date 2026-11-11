// ブラウザの検査が返す値が、Consoleの型ガードを通ることを確かめる。
// 通らないと、Consoleは失敗の表示を描き、検査が本来の画面を見なくなる。

import { describe, expect, test } from "bun:test";
import { classifyRunResponse } from "../src/api/errors.ts";
import { isResultUnknown } from "../src/api/executeWrite.ts";
import { isApprovalDesignDocRows } from "../src/api/guards/approvalDesignDoc.ts";
import { isDesignDocRows } from "../src/api/guards/design.ts";
import { isHoldsSnapshot } from "../src/api/guards/holds.ts";
import { isInboxRows } from "../src/api/guards/inboxProposals.ts";
import { isIntakeSnapshotRows } from "../src/api/guards/intakeSnapshot.ts";
import { isIntakeTargets } from "../src/api/guards/intakeTargets.ts";
import { isPipelineRows } from "../src/api/guards/pipeline.ts";
import { isRecord } from "../src/api/guards/primitives.ts";
import {
  isRequirementsDocRows,
  isRequirementsIndexRows,
} from "../src/api/guards/requirements.ts";
import { isConsoleSummary } from "../src/api/guards/summary.ts";
import { isSystemStatus } from "../src/api/guards/systemStatus.ts";
import { isWorkItemDetail } from "../src/api/guards/workItemDetail.ts";
import {
  isApprovalDecideResult,
  isHoldPlaceResult,
  isJobCancelResult,
  isStopAllResult,
} from "../src/api/guards/writeResults.ts";
import {
  isConfigSnapshot,
  isJobDetail,
  isJobList,
  isSchedulesSnapshot,
} from "../src/api/jobsQueries.ts";
import { classifyDecisionRefusal } from "../src/lib/approvalRefusal.ts";
import { canCancelJob } from "../src/lib/jobActions.ts";
import {
  APPROVAL_DESIGN_DOC_NORMAL,
  APPROVAL_DESIGN_DOC_TRUNCATED_ITEM,
} from "./fixtures.ts";
import {
  type Mode,
  type Reply,
  replyFor,
  scriptOfPath,
  type WriteResult,
  type WriteScript,
} from "./responses.ts";

const QUERY = "f/factory/steps/console_query";
const JOBS = "f/factory/console_jobs";
const MODES: readonly Mode[] = ["normal", "empty"];

type Guard = (value: unknown) => boolean;

type Case = {
  readonly script: string;
  readonly args: unknown;
  readonly guard: Guard;
};

const CASES: readonly Case[] = [
  { script: QUERY, args: { view: "summary" }, guard: isConsoleSummary },
  { script: QUERY, args: { view: "pipeline" }, guard: isPipelineRows },
  {
    script: QUERY,
    args: { view: "requirements_index" },
    guard: isRequirementsIndexRows,
  },
  { script: QUERY, args: { view: "system_status" }, guard: isSystemStatus },
  { script: QUERY, args: { view: "inbox" }, guard: isInboxRows },
  {
    script: QUERY,
    args: { view: "intake_snapshot" },
    guard: isIntakeSnapshotRows,
  },
  {
    script: QUERY,
    args: { view: "intake_targets" },
    guard: isIntakeTargets,
  },
  {
    script: QUERY,
    args: { view: "approval_design_doc", approval_request_id: 3 },
    guard: isApprovalDesignDocRows,
  },
  {
    script: QUERY,
    args: { view: "requirements_doc" },
    guard: isRequirementsDocRows,
  },
  {
    script: QUERY,
    args: { view: "design_doc" },
    guard: isDesignDocRows,
  },
  { script: "f/factory/console_holds", args: {}, guard: isHoldsSnapshot },
  { script: JOBS, args: { view: "active" }, guard: isJobList },
  { script: JOBS, args: { view: "history" }, guard: isJobList },
  {
    script: "f/factory/console_schedules",
    args: {},
    guard: isSchedulesSnapshot,
  },
  { script: "f/factory/console_config", args: {}, guard: isConfigSnapshot },
];

function passes(testCase: Case, mode: Mode): boolean {
  const reply = replyFor(testCase.script, testCase.args, mode);
  return reply !== null && reply.status === 200 && testCase.guard(reply.body);
}

describe("the replies of the browser checks pass the guards of the console", () => {
  for (const mode of MODES) {
    for (const testCase of CASES) {
      test(`${testCase.script} ${JSON.stringify(testCase.args)} (${mode})`, () => {
        expect(passes(testCase, mode)).toBe(true);
      });
    }
  }

  test("the work item detail passes the guard", () => {
    const reply = replyFor(QUERY, { view: "work_item_detail" }, "normal");

    expect(reply !== null && isWorkItemDetail(reply.body)).toBe(true);
  });

  test("the job detail passes the guard", () => {
    const reply = replyFor(JOBS, { view: "detail" }, "normal");

    expect(reply !== null && isJobDetail(reply.body)).toBe(true);
  });
});

describe("the holds reply", () => {
  test("carries the stop-all state, so that the accessibility scan reaches its panel", () => {
    const reply = replyFor("f/factory/console_holds", {}, "normal");

    expect(isRecord(reply?.body) ? reply.body.stop_all : undefined).toEqual({
      kind: "clear",
    });
  });
});

describe("the design of an approval request", () => {
  function designBody(id: number): unknown {
    return replyFor(
      QUERY,
      { view: "approval_design_doc", approval_request_id: id },
      "normal",
    )?.body;
  }

  test("returns the design by approval request id", () => {
    expect(designBody(3)).toEqual([APPROVAL_DESIGN_DOC_NORMAL]);
  });

  test("returns the design of another approval request by its id", () => {
    expect(designBody(9)).toEqual([APPROVAL_DESIGN_DOC_TRUNCATED_ITEM]);
  });

  test("returns no design for an id that the table does not have", () => {
    expect(designBody(99)).toEqual([]);
  });
});

describe("the reply for a missing work item", () => {
  test("is a failed job", () => {
    const reply = replyFor(QUERY, { view: "work_item_detail" }, "empty");

    expect(reply?.status).toBe(500);
  });

  test("names the work item that the screen asks for", () => {
    const reply = replyFor(QUERY, { view: "work_item_detail" }, "empty");

    expect(JSON.stringify(reply?.body)).toContain(
      "console_query: no work item with id 7",
    );
  });
});

describe("requests the checks do not expect", () => {
  test("a write script gets no reply", () => {
    expect(replyFor("f/factory/hold_release", {}, "normal")).toBeNull();
  });

  test("an unknown view gets no reply", () => {
    expect(replyFor(QUERY, { view: "unknown_view" }, "normal")).toBeNull();
  });

  test("a body that is not a record gets no reply", () => {
    expect(replyFor(QUERY, "summary", "normal")).toBeNull();
  });
});

const APPROVAL = "f/factory/approval_decide";
const CANCEL = "f/factory/console_job_cancel";
const PLACE = "f/factory/console_hold_place";
const STOP_ALL = "f/factory/console_stop_all";

const APPROVE_ARGS = {
  approval_request_id: 1,
  decision: "approve",
  reason: "",
};
const CANCEL_ARGS = { job_id: "0190a1b2-c3d4-7e5f-8a9b-000000000002" };
const PLACE_ARGS = { kind: "merge", target: "o/r", minutes: 60, reason: "x" };
const STOP_ALL_ARGS = { reason: "x" };

/** 1つの書き込みを、選んだ結果で応答させる。 */
function writeReplyOf(
  script: WriteScript,
  args: unknown,
  result: WriteResult,
): Reply | null {
  return replyFor(script, args, "normal", { [script]: result });
}

/** 応答を、Consoleが`run_wait_result`の応答を読むのと同じ手順で分類する。 */
function classified(reply: Reply | null) {
  return classifyRunResponse(
    reply?.status ?? 0,
    JSON.stringify(reply?.body ?? null),
  );
}

describe("write replies", () => {
  test("a write script that the check did not choose gets no reply", () => {
    expect(replyFor(STOP_ALL, {}, "normal", { [PLACE]: "success" })).toBeNull();
  });

  test.each([
    [APPROVAL, APPROVE_ARGS, "success", isApprovalDecideResult],
    [CANCEL, CANCEL_ARGS, "success", isJobCancelResult],
    [CANCEL, CANCEL_ARGS, "refused", isJobCancelResult],
    [PLACE, PLACE_ARGS, "success", isHoldPlaceResult],
    [PLACE, PLACE_ARGS, "refused", isHoldPlaceResult],
    [STOP_ALL, STOP_ALL_ARGS, "success", isStopAllResult],
    [STOP_ALL, STOP_ALL_ARGS, "refused", isStopAllResult],
  ] as const)(
    "%s (%o) %s passes the guard of the console",
    (script, args, result, guard) => {
      const reply = writeReplyOf(script, args, result);

      expect(reply?.status === 200 && guard(reply.body)).toBe(true);
    },
  );

  test("the approval success records the decision that the request sent", () => {
    const reply = writeReplyOf(
      APPROVAL,
      { ...APPROVE_ARGS, decision: "reject" },
      "success",
    );

    expect(isRecord(reply?.body) ? reply.body.status : undefined).toBe(
      "rejected",
    );
  });

  test("a refused approval is a failed job that the console reads as a recorded decision", () => {
    const run = classified(writeReplyOf(APPROVAL, APPROVE_ARGS, "refused"));

    expect(run.ok ? undefined : classifyDecisionRefusal(run.error)?.kind).toBe(
      "conflict",
    );
  });

  test("a server error of an approval is not read as a refusal", () => {
    const run = classified(
      writeReplyOf(APPROVAL, APPROVE_ARGS, "server_error"),
    );

    expect(run.ok ? undefined : classifyDecisionRefusal(run.error)).toBeNull();
  });

  test.each([
    [APPROVAL, APPROVE_ARGS],
    [CANCEL, CANCEL_ARGS],
    [PLACE, PLACE_ARGS],
    [STOP_ALL, STOP_ALL_ARGS],
  ] as const)("a server error of %s is a 500", (script, args) => {
    expect(writeReplyOf(script, args, "server_error")?.status).toBe(500);
  });

  test("a server error is a result the console cannot know", () => {
    const run = classified(
      writeReplyOf(STOP_ALL, STOP_ALL_ARGS, "server_error"),
    );

    expect(run.ok ? undefined : isResultUnknown(run.error)).toBe(true);
  });

  test("the hold place success echoes the kind and the target", () => {
    const reply = writeReplyOf(PLACE, PLACE_ARGS, "success");

    expect(
      isRecord(reply?.body)
        ? { kind: reply.body.kind, target: reply.body.target }
        : undefined,
    ).toEqual({ kind: "merge", target: "o/r" });
  });
});

describe("the job detail", () => {
  function detailOf(jobId: string): unknown {
    return replyFor(JOBS, { view: "detail", job_id: jobId }, "normal")?.body;
  }

  test("returns the running flow job for its id", () => {
    const body = detailOf(CANCEL_ARGS.job_id);

    expect(isRecord(body) && isRecord(body.job) ? body.job.id : undefined).toBe(
      CANCEL_ARGS.job_id,
    );
  });

  test("the running flow job can be canceled", () => {
    const body = detailOf(CANCEL_ARGS.job_id);

    expect(isJobDetail(body) && body.found && canCancelJob(body.job)).toBe(
      true,
    );
  });
});

describe("scriptOfPath", () => {
  test("reads the script path of a run request", () => {
    expect(
      scriptOfPath(
        "/api/w/factory/jobs/run_wait_result/p/f/factory/console_holds",
      ),
    ).toBe("f/factory/console_holds");
  });

  test("returns null for a path that does not run a script", () => {
    expect(scriptOfPath("/api/version")).toBeNull();
  });
});
