import { describe, expect, test } from "bun:test";
import {
  CANCELABLE_FLOW_PATHS,
  canCancelJob,
  cancelDialogLines,
  DEPENDABOT_FLOW_PATH,
} from "./jobActions.ts";

function job(overrides: Record<string, unknown> = {}) {
  return {
    state: "running",
    script_path: "f/factory/implement",
    job_kind: "flow",
    parent_job: null,
    is_flow_step: false,
    tag: "flow",
    ...overrides,
  };
}

describe("canCancelJob", () => {
  test("allows a running flow of a work item", () => {
    expect(canCancelJob(job())).toBe(true);
  });

  test("allows a flow that waits for a worker", () => {
    expect(canCancelJob(job({ state: "queued" }))).toBe(true);
  });

  test.each(CANCELABLE_FLOW_PATHS)("allows the flow %s", (path) => {
    expect(canCancelJob(job({ script_path: path }))).toBe(true);
  });

  test.each(["scheduled", "success", "failure", "canceled", "skipped"])(
    "does not allow a job in the state %s",
    (state) => {
      expect(canCancelJob(job({ state }))).toBe(false);
    },
  );

  test("does not allow a script job", () => {
    expect(canCancelJob(job({ job_kind: "script" }))).toBe(false);
  });

  test("does not allow a flow that is not on the list", () => {
    expect(canCancelJob(job({ script_path: "f/factory/manual_intake" }))).toBe(
      false,
    );
  });

  test("does not allow a path that only starts like an allowed flow", () => {
    expect(
      canCancelJob(job({ script_path: "f/factory/implement_prepare" })),
    ).toBe(false);
  });

  test("does not allow a step of a flow", () => {
    expect(canCancelJob(job({ is_flow_step: true }))).toBe(false);
  });

  test("does not allow a job that has a parent", () => {
    expect(
      canCancelJob(job({ parent_job: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d" })),
    ).toBe(false);
  });

  test("does not allow a job of the Console worker", () => {
    expect(canCancelJob(job({ tag: "console" }))).toBe(false);
  });

  test("does not allow a state it does not know", () => {
    expect(canCancelJob(job({ state: "weird" }))).toBe(false);
  });
});

describe("cancelDialogLines", () => {
  test("says that the cancel cannot be undone", () => {
    expect(cancelDialogLines("f/factory/implement").join("\n")).toContain(
      "元に戻せません",
    );
  });

  test("says that child processes can keep running", () => {
    expect(cancelDialogLines("f/factory/implement").join("\n")).toContain(
      "子プロセス",
    );
  });

  test("says when the child processes are cleaned up", () => {
    expect(cancelDialogLines("f/factory/implement").join("\n")).toContain(
      "翌日03:00の掃除",
    );
  });

  test("says that the work item fails at the next check", () => {
    expect(cancelDialogLines("f/factory/implement").join("\n")).toContain(
      "次の照合で失敗",
    );
  });

  test("does not mention the dependabot rule for another flow", () => {
    expect(cancelDialogLines("f/factory/implement").join("\n")).not.toContain(
      "dependabot",
    );
  });

  test("adds the dependabot rule for the dependabot flow", () => {
    expect(cancelDialogLines(DEPENDABOT_FLOW_PATH).join("\n")).toContain(
      "再実行できません",
    );
  });

  test("tells the person to merge the pull request by hand for dependabot", () => {
    expect(cancelDialogLines(DEPENDABOT_FLOW_PATH).join("\n")).toContain(
      "人の手",
    );
  });
});
