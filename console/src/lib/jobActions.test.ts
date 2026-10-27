import { describe, expect, test } from "bun:test";
import {
  CANCELABLE_FLOW_PATHS,
  canCancelJob,
  cancelDialogHandlers,
  cancelDialogLines,
  canRerunJob,
  DEPENDABOT_FLOW_PATH,
  RERUNNABLE_SCHEDULE_PATHS,
  rerunDialogLines,
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

  test.each([...CANCELABLE_FLOW_PATHS])("allows the flow %s", (path) => {
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

function lines(flowPath: string, state: "running" | "queued" = "running") {
  return cancelDialogLines(flowPath, state).join("\n");
}

describe("cancelDialogLines", () => {
  test("says that the cancel cannot be undone", () => {
    expect(lines("f/factory/implement")).toContain("元に戻せません");
  });

  test("says that child processes can keep running", () => {
    expect(lines("f/factory/implement")).toContain("子プロセス");
  });

  test("says that the cost of the leftover Claude may escape the daily budget", () => {
    expect(lines("f/factory/implement")).toContain(
      "日次予算に数えられないことがあります",
    );
  });

  test("says when the child processes are cleaned up", () => {
    expect(lines("f/factory/implement")).toContain("毎日03:00の掃除");
  });

  test("says that the cleanup only stops what outlived the time limit", () => {
    expect(lines("f/factory/implement")).toContain(
      "実行の上限時間に5分を足した時間を過ぎたものだけ",
    );
  });

  test("does not promise that the cleanup stops the processes the next day", () => {
    expect(lines("f/factory/implement")).not.toContain("翌日");
  });

  test("says that the next run of the implement flow stops the leftover processes", () => {
    expect(lines("f/factory/implement")).toContain("準備のステップ");
  });

  test("keeps the implement sentence out of the dialog of another flow", () => {
    expect(lines("f/factory/design")).not.toContain("準備のステップ");
  });

  test("says that the work item fails at the next check", () => {
    expect(lines("f/factory/implement")).toContain("次の照合");
  });

  test("says that a work item that waits for approval does not fail", () => {
    expect(lines("f/factory/pipeline")).toContain(
      "承認待ちの作業項目は失敗にならず、承認待ちのまま残ります",
    );
  });

  test("warns that the notice of a waiting approval may not arrive", () => {
    expect(lines("f/factory/pipeline")).toContain(
      "承認依頼の通知は届かないことがあります",
    );
  });

  test("does not mention the dependabot rule for another flow", () => {
    expect(lines("f/factory/implement")).not.toContain("dependabot");
  });

  test("adds the dependabot rule for the dependabot flow", () => {
    expect(lines(DEPENDABOT_FLOW_PATH)).toContain("再実行できません");
  });

  test("tells the person to merge the pull request by hand for dependabot", () => {
    expect(lines(DEPENDABOT_FLOW_PATH)).toContain("人の手");
  });

  test("names the job that waits for a worker as a waiting flow", () => {
    expect(lines("f/factory/implement", "queued")).toContain("待ちのフロー");
  });

  test("leaves the child processes out for a flow that has not started", () => {
    expect(lines("f/factory/implement", "queued")).not.toContain("子プロセス");
  });

  test("leaves the cleanup out for a flow that has not started", () => {
    expect(lines("f/factory/implement", "queued")).not.toContain("03:00");
  });

  test("still says that the work item fails at the next check for a waiting flow", () => {
    expect(lines("f/factory/implement", "queued")).toContain("次の照合");
  });

  test("says that the running flow is stopped", () => {
    expect(lines("f/factory/implement", "running")).toContain("実行中のフロー");
  });

  test("says that a stopped pull request fix starts again by itself", () => {
    expect(lines("f/factory/pr_fix")).toContain(
      "次のポーリングが新しい修正を自動で始めます",
    );
  });

  test("names the pending label that starts the fix again", () => {
    expect(lines("f/factory/pr_fix")).toContain("factory:fix");
  });

  test("says that the watch of the CI starts the fix of the same pull request again", () => {
    expect(lines("f/factory/pr_fix")).toContain("CIの監視");
  });

  test("warns that a leftover process can block the next fix", () => {
    expect(lines("f/factory/pr_fix")).toContain("worktree");
  });

  test("leaves the worktree conflict out for a pull request fix that has not started", () => {
    expect(lines("f/factory/pr_fix", "queued")).not.toContain("worktree");
  });

  test("keeps the pull request fix sentences out of the dialog of another flow", () => {
    expect(lines("f/factory/implement")).not.toContain("factory:fix");
  });
});

describe("cancelDialogHandlers", () => {
  const JOB = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

  function setup() {
    const opened: boolean[] = [];
    const submitted: string[] = [];
    const handlers = cancelDialogHandlers({
      jobId: JOB,
      setOpen: (open) => {
        opened.push(open);
      },
      submit: (id) => {
        submitted.push(id);
      },
    });
    return { handlers, opened, submitted };
  }

  test("opens the dialog when the button is pressed", () => {
    const { handlers, opened } = setup();
    handlers.onOpen();
    expect(opened).toEqual([true]);
  });

  test("does not stop the job when the dialog only opens", () => {
    const { handlers, submitted } = setup();
    handlers.onOpen();
    expect(submitted).toEqual([]);
  });

  test("stops the job once when the person confirms", () => {
    const { handlers, submitted } = setup();
    handlers.onConfirm();
    expect(submitted).toEqual([JOB]);
  });

  test("closes the dialog when the person confirms", () => {
    const { handlers, opened } = setup();
    handlers.onConfirm();
    expect(opened).toEqual([false]);
  });

  test("does not stop the job when the person dismisses the dialog", () => {
    const { handlers, submitted } = setup();
    handlers.onDismiss();
    expect(submitted).toEqual([]);
  });

  test("closes the dialog when the person dismisses it", () => {
    const { handlers, opened } = setup();
    handlers.onDismiss();
    expect(opened).toEqual([false]);
  });
});

function failedRun(overrides: Record<string, unknown> = {}) {
  return {
    state: "failure",
    script_path: "f/factory/collect_github",
    job_kind: "script",
    schedule_path: "f/factory/collect_github",
    parent_job: null,
    is_flow_step: false,
    tag: "periodic",
    ...overrides,
  };
}

describe("canRerunJob", () => {
  test("allows a failed run of a listed schedule", () => {
    expect(canRerunJob(failedRun())).toBe(true);
  });

  test.each([...RERUNNABLE_SCHEDULE_PATHS])(
    "allows a failed run of %s",
    (path) => {
      expect(
        canRerunJob(failedRun({ script_path: path, schedule_path: path })),
      ).toBe(true);
    },
  );

  test.each([
    "running",
    "queued",
    "scheduled",
    "success",
    "canceled",
    "skipped",
  ])("does not allow a job in the state %s", (state) => {
    expect(canRerunJob(failedRun({ state }))).toBe(false);
  });

  test("does not allow a run that did not come from a schedule", () => {
    expect(canRerunJob(failedRun({ schedule_path: null }))).toBe(false);
  });

  test("does not allow a schedule that is not on the list", () => {
    expect(
      canRerunJob(
        failedRun({
          script_path: "f/factory/self_update",
          schedule_path: "f/factory/self_update",
        }),
      ),
    ).toBe(false);
  });

  test("does not allow a script that differs from the one of the schedule", () => {
    expect(
      canRerunJob(failedRun({ script_path: "f/factory/self_update" })),
    ).toBe(false);
  });

  test("does not allow a flow", () => {
    expect(canRerunJob(failedRun({ job_kind: "flow" }))).toBe(false);
  });

  test("does not allow a run that has a parent", () => {
    expect(
      canRerunJob(
        failedRun({ parent_job: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" }),
      ),
    ).toBe(false);
  });

  test("does not allow a job of the Console worker", () => {
    expect(canRerunJob(failedRun({ tag: "console" }))).toBe(false);
  });
});

describe("rerunDialogLines", () => {
  test("says the schedule's own arguments are used", () => {
    expect(rerunDialogLines("f/factory/collect_github").join("\n")).toContain(
      "scheduleに定義された引数",
    );
  });

  test("says that the failed job stays and the result is a new job", () => {
    expect(rerunDialogLines("f/factory/collect_github").join("\n")).toContain(
      "新しいジョブ",
    );
  });

  test("says what the collection does", () => {
    expect(rerunDialogLines("f/factory/collect_github").join("\n")).toContain(
      "GitHub",
    );
  });

  test("says what the automatic retry does", () => {
    expect(
      rerunDialogLines("f/factory/auto_retry_pr_review").join("\n"),
    ).toContain("PRレビュー");
  });

  test.each([...RERUNNABLE_SCHEDULE_PATHS])(
    "gives %s a sentence of its own",
    (path) => {
      expect(rerunDialogLines(path).length).toBeGreaterThanOrEqual(3);
    },
  );

  test("does not say the rerun can be undone", () => {
    expect(
      rerunDialogLines("f/factory/collect_github").join("\n"),
    ).not.toContain("元に戻せます");
  });
});
