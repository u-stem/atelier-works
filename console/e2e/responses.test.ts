// ブラウザの検査が返す値が、Consoleの型ガードを通ることを確かめる。
// 通らないと、Consoleは失敗の表示を描き、検査が本来の画面を見なくなる。

import { describe, expect, test } from "bun:test";
import { isApprovalDesignDocRows } from "../src/api/guards/approvalDesignDoc.ts";
import { isDesignDocRows } from "../src/api/guards/design.ts";
import { isHoldsSnapshot } from "../src/api/guards/holds.ts";
import { isIntakeSnapshotRows } from "../src/api/guards/intakeSnapshot.ts";
import { isIntakeTargets } from "../src/api/guards/intakeTargets.ts";
import { isPipelineRows } from "../src/api/guards/pipeline.ts";
import {
  isRequirementsDocRows,
  isRequirementsIndexRows,
} from "../src/api/guards/requirements.ts";
import { isConsoleSummary } from "../src/api/guards/summary.ts";
import { isSystemStatus } from "../src/api/guards/systemStatus.ts";
import { isWorkItemDetail } from "../src/api/guards/workItemDetail.ts";
import {
  isConfigSnapshot,
  isJobDetail,
  isJobList,
  isSchedulesSnapshot,
} from "../src/api/jobsQueries.ts";
import { type Mode, replyFor, scriptOfPath } from "./responses.ts";

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
    args: { view: "approval_design_doc" },
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
