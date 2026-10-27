import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { JobSummaryView } from "../../api/jobsQueries.ts";
import {
  CancelDialog,
  JobActions,
  OpenCancelButton,
  OpenRerunButton,
  RerunDialog,
} from "./JobActions.tsx";

const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

function job(overrides: Partial<JobSummaryView> = {}): JobSummaryView {
  return {
    id: ID,
    state: "running",
    script_path: "f/factory/implement",
    job_kind: "flow",
    created_at: "2026-10-27T02:00:00.000000Z",
    started_at: "2026-10-27T02:00:01.000000Z",
    completed_at: null,
    scheduled_for: null,
    duration_ms: null,
    schedule_path: null,
    parent_job: null,
    tag: "flow",
    is_flow_step: false,
    ...overrides,
  };
}

function renderActions(target: JobSummaryView, workItemId: number | null = 7) {
  const client = new QueryClient();
  return renderToStaticMarkup(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <JobActions job={target} workItemId={workItemId} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function renderDialog(
  target: JobSummaryView | null,
  workItemId: number | null = 7,
) {
  return renderToStaticMarkup(
    <CancelDialog
      job={target}
      workItemId={workItemId}
      onConfirm={() => undefined}
      onCancel={() => undefined}
    />,
  );
}

describe("JobActions", () => {
  test("offers to stop a running flow of a work item", () => {
    expect(renderActions(job())).toContain("ジョブを中止");
  });

  test("offers to stop a flow that waits for a worker", () => {
    expect(renderActions(job({ state: "queued" }))).toContain("ジョブを中止");
  });

  test("renders nothing for a job that has finished", () => {
    expect(renderActions(job({ state: "success" }))).toBe("");
  });

  test("renders nothing for a job that is scheduled for later", () => {
    expect(renderActions(job({ state: "scheduled" }))).toBe("");
  });

  test("renders nothing for a flow that is not on the list", () => {
    expect(renderActions(job({ script_path: "f/factory/manual_intake" }))).toBe(
      "",
    );
  });

  test("renders nothing for a step of a flow", () => {
    expect(renderActions(job({ is_flow_step: true }))).toBe("");
  });

  test("keeps the sentences of the confirmation out of the page until the dialog opens", () => {
    expect(renderActions(job())).not.toContain("元に戻せません");
  });
});

describe("CancelDialog", () => {
  test("shows the job id in mono", () => {
    expect(renderDialog(job())).toMatch(
      new RegExp(`font-mono[^>]*>${ID}</dd>`),
    );
  });

  test("shows the flow name in mono", () => {
    expect(renderDialog(job())).toMatch(/font-mono[^>]*>implement<\/dd>/);
  });

  test("asks whether to stop the job", () => {
    expect(renderDialog(job())).toContain("このジョブを中止しますか");
  });

  test("names the flow", () => {
    expect(renderDialog(job())).toContain("implement");
  });

  test("names the job", () => {
    expect(renderDialog(job())).toContain(ID);
  });

  test("names the work item by its number", () => {
    expect(renderDialog(job(), 7)).toContain(">#7<");
  });

  test("does not repeat the words work item in the value", () => {
    expect(renderDialog(job(), 7)).not.toContain("作業項目 #7");
  });

  test("leaves the work item out when the job has none", () => {
    expect(renderDialog(job(), null)).not.toContain(">作業項目</dt>");
  });

  test("leaves the child processes out for a flow that waits for a worker", () => {
    expect(renderDialog(job({ state: "queued" }))).not.toContain("子プロセス");
  });

  test("names a flow that waits for a worker as a waiting flow", () => {
    expect(renderDialog(job({ state: "queued" }))).toContain("待ちのフロー");
  });

  test("says that the stop cannot be undone", () => {
    expect(renderDialog(job())).toContain("元に戻せません");
  });

  test("says that child processes can keep running", () => {
    expect(renderDialog(job())).toContain("子プロセス");
  });

  test("labels the button that runs the stop apart from the one that dismisses", () => {
    expect(renderDialog(job())).toContain("中止する");
  });

  test("keeps the dependabot sentence out of the dialog of another flow", () => {
    expect(renderDialog(job())).not.toContain("再実行できません");
  });

  test("adds the dependabot sentence for the dependabot flow", () => {
    expect(
      renderDialog(job({ script_path: "f/factory/dependabot" })),
    ).toContain("再実行できません");
  });

  test("asks nothing when no job is chosen", () => {
    expect(renderDialog(null)).not.toContain("このジョブを中止しますか");
  });

  test("hides characters that change how the text reads", () => {
    const hostile = job({ script_path: "f/factory/impl‮ement" });
    expect(renderDialog(hostile)).not.toContain("‮");
  });
});

describe("the parts that carry the operation", () => {
  test("opens the dialog when the button is pressed", () => {
    const calls: string[] = [];
    OpenCancelButton({
      locked: false,
      onOpen: () => {
        calls.push("open");
      },
    }).props.onClick();
    expect(calls).toEqual(["open"]);
  });

  test("keeps the button off while the job is being stopped", () => {
    const element = OpenCancelButton({ locked: true, onOpen: () => undefined });
    expect(element.props.disabled).toBe(true);
  });

  test("leaves the button on when nothing is running", () => {
    const element = OpenCancelButton({
      locked: false,
      onOpen: () => undefined,
    });
    expect(element.props.disabled).toBe(false);
  });

  test("hands the confirmation of the dialog to the confirm handler", () => {
    const onConfirm = () => undefined;
    const element = CancelDialog({
      job: job(),
      workItemId: 7,
      onConfirm,
      onCancel: () => undefined,
    });
    expect(element.props.onConfirm).toBe(onConfirm);
  });

  test("hands both the cancel button and Esc of the dialog to the dismiss handler", () => {
    const onCancel = () => undefined;
    const element = CancelDialog({
      job: job(),
      workItemId: 7,
      onConfirm: () => undefined,
      onCancel,
    });
    expect(element.props.onCancel).toBe(onCancel);
  });

  test("opens the dialog only for a job", () => {
    const element = CancelDialog({
      job: null,
      workItemId: null,
      onConfirm: () => undefined,
      onCancel: () => undefined,
    });
    expect(element.props.open).toBe(false);
  });
});

function failedRun(overrides: Partial<JobSummaryView> = {}): JobSummaryView {
  return job({
    state: "failure",
    script_path: "f/factory/collect_github",
    job_kind: "script",
    schedule_path: "f/factory/collect_github",
    tag: "periodic",
    completed_at: "2026-10-27T02:05:00.000000Z",
    ...overrides,
  });
}

function renderRerunDialog(target: JobSummaryView | null) {
  return renderToStaticMarkup(
    <RerunDialog
      job={target}
      onConfirm={() => undefined}
      onCancel={() => undefined}
    />,
  );
}

describe("JobActions for a failed scheduled run", () => {
  test("offers to run it again", () => {
    expect(renderActions(failedRun())).toContain("ジョブを再実行");
  });

  test("does not offer to stop it", () => {
    expect(renderActions(failedRun())).not.toContain("ジョブを中止");
  });

  test("renders nothing for a run that did not come from a schedule", () => {
    expect(renderActions(failedRun({ schedule_path: null }))).toBe("");
  });

  test("renders nothing for a run of a schedule that is not on the list", () => {
    expect(
      renderActions(
        failedRun({
          script_path: "f/factory/self_update",
          schedule_path: "f/factory/self_update",
        }),
      ),
    ).toBe("");
  });

  test("renders nothing for a run that succeeded", () => {
    expect(renderActions(failedRun({ state: "success" }))).toBe("");
  });

  test("keeps the sentences of the confirmation out of the page until the dialog opens", () => {
    expect(renderActions(failedRun())).not.toContain(
      "scheduleに定義された引数",
    );
  });
});

describe("RerunDialog", () => {
  test("shows the failed job id in mono", () => {
    expect(renderRerunDialog(failedRun())).toMatch(
      new RegExp(`font-mono[^>]*>${ID}</dd>`),
    );
  });

  test("asks whether to run the job again", () => {
    expect(renderRerunDialog(failedRun())).toContain(
      "この定期ジョブを再実行しますか",
    );
  });

  test("names the script", () => {
    expect(renderRerunDialog(failedRun())).toContain("collect_github");
  });

  test("names the failed job", () => {
    expect(renderRerunDialog(failedRun())).toContain(ID);
  });

  test("says that the arguments come from the schedule", () => {
    expect(renderRerunDialog(failedRun())).toContain(
      "scheduleに定義された引数",
    );
  });

  test("labels the button that runs it apart from the one that dismisses", () => {
    expect(renderRerunDialog(failedRun())).toContain("再実行する");
  });

  test("does not paint the confirm button as destructive", () => {
    expect(renderRerunDialog(failedRun())).not.toContain("bg-destructive");
  });

  test("asks nothing when no job is chosen", () => {
    expect(renderRerunDialog(null)).not.toContain(
      "この定期ジョブを再実行しますか",
    );
  });

  test("hides characters that change how the text reads", () => {
    const hostile = failedRun({ script_path: "f/factory/collect‮_github" });
    expect(renderRerunDialog(hostile)).not.toContain("‮");
  });

  test("hands the confirmation of the dialog to the confirm handler", () => {
    const onConfirm = () => undefined;
    const element = RerunDialog({
      job: failedRun(),
      onConfirm,
      onCancel: () => undefined,
    });
    expect(element.props.onConfirm).toBe(onConfirm);
  });

  test("hands both the cancel button and Esc of the dialog to the dismiss handler", () => {
    const onCancel = () => undefined;
    const element = RerunDialog({
      job: failedRun(),
      onConfirm: () => undefined,
      onCancel,
    });
    expect(element.props.onCancel).toBe(onCancel);
  });

  test("opens the dialog only for a job", () => {
    const element = RerunDialog({
      job: null,
      onConfirm: () => undefined,
      onCancel: () => undefined,
    });
    expect(element.props.open).toBe(false);
  });
});

describe("OpenRerunButton", () => {
  test("opens the dialog when the button is pressed", () => {
    const calls: string[] = [];
    OpenRerunButton({
      locked: false,
      onOpen: () => {
        calls.push("open");
      },
    }).props.onClick();
    expect(calls).toEqual(["open"]);
  });

  test("keeps the button off while the run is being started", () => {
    const element = OpenRerunButton({ locked: true, onOpen: () => undefined });
    expect(element.props.disabled).toBe(true);
  });
});
