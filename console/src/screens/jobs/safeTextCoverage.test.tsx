// サーバー由来の文字列のすべての項目に、見えない文字を入れて描き、画面に残らないことを確かめる。
// 項目を足したときに無害化を忘れると、ここで落ちる。
// ソースの検査は`tests/scripts/console_jobs_render_contract.test.ts`が行う。

import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { freshQuery } from "../../api/fakeSectionQuery.testing.ts";
import type { HoldsSnapshot } from "../../api/guards/holds.ts";
import {
  type JobDetailView,
  type JobSummaryView,
  jobDetailQueryKey,
  type ScheduleViewData,
} from "../../api/jobsQueries.ts";
import { TooltipProvider } from "../../components/ui/tooltip.tsx";
import { flowDiagramModel } from "../../lib/flowDiagram.ts";
import type { FlowDefinition, FlowsData } from "../../lib/flowsData.ts";
import { ItemFlowProgressView } from "../items/detail/ItemFlowProgress.tsx";
import { ConfigList } from "../system/ConfigSection.tsx";
import { FlowDiagramFrame } from "./FlowDiagram.tsx";
import { FlowScreenView } from "./FlowScreen.tsx";
import {
  ArgList,
  FailureCauses,
  JobOverview,
  OutputSection,
  StepList,
} from "./JobDetailParts.tsx";
import { JobDetailScreen } from "./JobDetailScreen.tsx";
import { JobList, JobStateBadge } from "./JobRows.tsx";
import { ScheduleList } from "./ScheduleList.tsx";

/**
 * 分類ごとの代表の文字。ゼロ幅、双方向の制御、行の区切り、異体字セレクタ、C0の制御、ESC。
 * 文字はコードポイントから作る。ソースに並びを入れ替える文字を直接書かないためである。
 */
const HIDDEN_CODE_POINTS = [
  0x200b, 0x2066, 0x2069, 0x202e, 0x2028, 0xfe0f, 0x0007, 0x001b,
];
const HIDDEN = HIDDEN_CODE_POINTS.map((codePoint) =>
  String.fromCodePoint(codePoint),
);

/** 分類ごとの代表の文字と、ANSIの色の列を含む文字列。 */
const BAD = `a${HIDDEN.join("")}[31mc`;

/** 描画の結果に、代表の文字が1つでも残っているか。 */
function leaks(html: string): boolean {
  return HIDDEN.some((character) => html.includes(character));
}

const NOW = Date.parse("2026-10-26T05:10:00.000Z");

function render(element: ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <MemoryRouter>{element}</MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** 文字列の項目のすべてに`BAD`を入れたジョブ。 */
const JOB: JobSummaryView = {
  id: BAD,
  state: BAD,
  script_path: `f/factory/${BAD}`,
  job_kind: BAD,
  created_at: "2026-10-26T05:00:00.000000Z",
  started_at: "2026-10-26T05:00:01.000000Z",
  completed_at: "2026-10-26T05:00:03.000000Z",
  scheduled_for: null,
  duration_ms: 2000,
  schedule_path: `f/factory/${BAD}`,
  parent_job: BAD,
  tag: BAD,
  is_flow_step: false,
};

const SCHEDULE: ScheduleViewData = {
  path: `f/factory/${BAD}`,
  script_path: `f/factory/${BAD}`,
  is_flow: false,
  schedule: BAD,
  timezone: BAD,
  enabled: true,
  summary: BAD,
  paused_until: null,
  edited_at: null,
  error: BAD,
  next_run_at: null,
  recent_runs: [{ job_id: BAD, success: true, duration_ms: 1000 }],
  definition: BAD,
  differences: [BAD],
};

const HOLDS: HoldsSnapshot = {
  holds: { ok: true, rows: [] },
  freezes: { ok: true, schedule: [], deploy: [] },
};

const DETAIL_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

/** 文字列の項目のすべてに`BAD`を入れた詳細を、キャッシュから描く。 */
function detailScreen(): ReactElement {
  const detail: JobDetailView = {
    found: true,
    job: JOB,
    args: [{ key: BAD, type: BAD, value: BAD }],
    steps: [
      { id: BAD, state: BAD, job_id: BAD, iterations: null, skipped: false },
    ],
    log: { text: BAD, truncated: false, masked: false, nonJsonLines: 0 },
    result: { text: BAD, truncated: false, masked: false },
    result_error: BAD,
    failures: {
      ok: true,
      items: [
        {
          step: BAD,
          error: BAD,
          occurred_at: "2026-10-26T05:00:02.000Z",
          job_id: BAD,
        },
      ],
    },
  };
  const client = new QueryClient();
  client.setQueryData(
    jobDetailQueryKey(DETAIL_ID, { includeOutput: true }),
    detail,
  );
  return (
    <QueryClientProvider client={client}>
      <Routes location={`/jobs/${DETAIL_ID}`}>
        <Route path="/jobs/:id" element={<JobDetailScreen />} />
      </Routes>
    </QueryClientProvider>
  );
}

/** 文字列の項目のすべてに`BAD`を入れたflowの定義。flowの名前は、リンクに入れるので安全な形にする。 */
const FLOW: FlowDefinition = {
  name: "pipeline",
  summary: BAD,
  description: BAD,
  steps: [
    {
      id: BAD,
      summary: BAD,
      scriptPath: `f/factory/steps/${BAD}`,
      conditional: true,
    },
  ],
  entries: [
    { kind: "schedule", name: BAD },
    { kind: "human", label: BAD },
    { kind: "script", name: BAD, caller: BAD },
    { kind: "flow", flow: "pipeline", via: "reject" },
    { kind: "flow", flow: "pipeline", via: "rework" },
  ],
  exits: [
    { flow: "pipeline", step: BAD, via: "approve" },
    { flow: "pipeline", step: BAD, via: "rework" },
  ],
  unwiredEntries: [{ kind: "flow", flow: "pipeline", via: "approve" }],
};

const SCHEDULE_FLOWS: FlowsData = {
  flows: [FLOW],
  schedules: [{ name: "pipeline_schedule", summary: BAD, flows: ["pipeline"] }],
};

const FLOWS: FlowsData = { flows: [FLOW], schedules: [] };

/** 定義のステップと、定義に無いステップの両方に、見えない文字を入れたジョブのステップ。 */
const FLOW_STEPS = [
  {
    id: BAD,
    state: BAD,
    job_id: DETAIL_ID,
    iterations: null,
    skipped: false,
  },
  { id: `${BAD}x`, state: BAD, job_id: BAD, iterations: null, skipped: false },
];

const CASES: readonly (readonly [string, () => ReactElement])[] = [
  ["the detail screen with its heading", detailScreen],
  [
    "the overview",
    () => (
      <JobOverview job={JOB} now={NOW} relatedItemId={null} back={undefined} />
    ),
  ],
  [
    "the arguments",
    () => (
      <ArgList
        args={[
          { key: BAD, type: BAD, value: BAD },
          { key: BAD, type: BAD },
        ]}
      />
    ),
  ],
  [
    "the steps",
    () => (
      <StepList
        steps={[
          {
            id: BAD,
            state: BAD,
            job_id: BAD,
            iterations: null,
            skipped: false,
          },
        ]}
        back={undefined}
      />
    ),
  ],
  [
    "the saved causes",
    () => (
      <FailureCauses
        failures={{
          ok: true,
          items: [
            {
              step: BAD,
              error: BAD,
              occurred_at: "2026-10-26T05:00:02.000Z",
              job_id: BAD,
            },
          ],
        }}
        now={NOW}
        back={undefined}
      />
    ),
  ],
  [
    "the reason the causes could not be read",
    () => (
      <FailureCauses
        failures={{ ok: false, reason: BAD }}
        now={NOW}
        back={undefined}
      />
    ),
  ],
  [
    "the log, the result and the reason it could not be read",
    () => (
      <OutputSection
        id="r"
        title="結果"
        kind="result"
        output={{ text: BAD, truncated: false, masked: false }}
        error={BAD}
        emptyText="なし"
      />
    ),
  ],
  ["the state badge", () => <JobStateBadge state={BAD} />],
  [
    "the flow diagram",
    () => (
      <FlowDiagramFrame
        model={flowDiagramModel(FLOW, FLOW_STEPS)}
        presentation="fit"
      />
    ),
  ],
  [
    "the flow diagram in the list",
    () => (
      <FlowDiagramFrame
        model={flowDiagramModel(FLOW, FLOW_STEPS)}
        presentation="list"
      />
    ),
  ],
  [
    "the flow screen",
    () => (
      <FlowScreenView name="pipeline" data={FLOWS} back={null} width={1100} />
    ),
  ],
  [
    "flow progress step id",
    () => (
      <JobList
        jobs={[{ ...JOB, job_kind: "flow", state: "running" }]}
        now={NOW}
        back=""
        time="active"
        stepLines={
          new Map([
            [
              BAD,
              {
                kind: "step",
                step: {
                  id: BAD,
                  state: BAD,
                  job_id: BAD,
                  iterations: null,
                  skipped: false,
                },
              },
            ],
          ])
        }
      />
    ),
  ],
  [
    "the flow progress of a work item",
    () => (
      <ItemFlowProgressView
        data={FLOWS}
        width={900}
        view={{
          kind: "steps",
          jobId: DETAIL_ID,
          flowPath: "f/factory/pipeline",
          jobState: BAD,
          steps: FLOW_STEPS,
          stale: true,
        }}
      />
    ),
  ],
  [
    "the flow progress of a work item whose flow is not in the data",
    () => (
      <ItemFlowProgressView
        data={FLOWS}
        width={900}
        view={{
          kind: "steps",
          jobId: DETAIL_ID,
          flowPath: `f/factory/${BAD}`,
          jobState: BAD,
          steps: FLOW_STEPS,
          stale: true,
        }}
      />
    ),
  ],
  [
    "the list of running jobs",
    () => <JobList jobs={[JOB]} now={NOW} back="" time="active" />,
  ],
  [
    "the list of finished jobs",
    () => <JobList jobs={[JOB]} now={NOW} back="" time="history" />,
  ],
  [
    "the schedules",
    () => (
      <ScheduleList
        schedules={freshQuery({
          schedules: [SCHEDULE],
          missing_in_workspace: [BAD],
          truncated: false,
        })}
        holds={freshQuery(HOLDS)}
      />
    ),
  ],
  [
    "the schedules with a description from the data",
    () => (
      <ScheduleList
        schedules={freshQuery({
          schedules: [{ ...SCHEDULE, path: "f/factory/pipeline_schedule" }],
          missing_in_workspace: [],
          truncated: false,
        })}
        holds={freshQuery(HOLDS)}
        flows={SCHEDULE_FLOWS}
      />
    ),
  ],
  [
    "the config",
    () => (
      <ConfigList
        items={[
          { key: BAD, kind: "value", value: BAD, masked: false },
          { key: BAD, kind: "value", value: [BAD], masked: false },
          { key: BAD, kind: "value", value: { [BAD]: BAD }, masked: false },
          { key: BAD, kind: "reference" },
        ]}
      />
    ),
  ],
];

describe("every string of the server is sanitized when it is drawn", () => {
  test.each(CASES)("in %s", (_name, element) => {
    expect(leaks(render(element()))).toBe(false);
  });

  test.each(CASES)("and %s still draws something", (_name, element) => {
    expect(render(element()).length).toBeGreaterThan(20);
  });
});

describe("the case of the current step in the coverage", () => {
  const draw = (name: string): string => {
    const found = CASES.find(([label]) => label === name);
    return found === undefined ? "" : render(found[1]());
  };

  test("draw the label of the current step, so the check does not pass on an empty row", () => {
    expect(draw("flow progress step id")).toContain("今のステップ");
  });
});

describe("the flow progress of a work item in the coverage", () => {
  test("draws the heading of the steps, so the check does not pass on an empty block", () => {
    const found = CASES.find(
      ([label]) => label === "the flow progress of a work item",
    );
    expect(found === undefined ? "" : render(found[1]())).toContain(
      "のステップ",
    );
  });

  test("draws the steps the definition lacks, so the check reaches the id of the unknown step", () => {
    const found = CASES.find(
      ([label]) => label === "the flow progress of a work item",
    );
    expect(found === undefined ? "" : render(found[1]())).toContain(
      "定義に無いステップ",
    );
  });

  test("draws the list of steps of a flow that is not in the data", () => {
    const found = CASES.find(
      ([label]) =>
        label ===
        "the flow progress of a work item whose flow is not in the data",
    );
    expect(found === undefined ? "" : render(found[1]())).toContain("<ol");
  });
});

describe("the description of a schedule in the coverage", () => {
  test("draws the description and the links of a schedule that the data knows", () => {
    const found = CASES.find(
      ([label]) => label === "the schedules with a description from the data",
    );
    expect(found === undefined ? "" : render(found[1]())).toContain("flowの図");
  });
});

describe("the flow diagram in the coverage", () => {
  const draw = (name: string): string => {
    const found = CASES.find(([label]) => label === name);
    return found === undefined ? "" : render(found[1]());
  };

  test("draws the heading of the steps the definition lacks, so the check does not pass on an empty block", () => {
    expect(draw("the flow diagram")).toContain("定義に無いステップ");
  });

  test("draws the steps the definition lacks in the list too", () => {
    expect(draw("the flow diagram in the list")).toContain(
      "定義に無いステップ",
    );
  });

  test("draws the ordered list of the steps in the list", () => {
    expect(draw("the flow diagram in the list")).toContain("<ol");
  });

  test("draws the diagram of the flow screen", () => {
    expect(draw("the flow screen")).toContain(
      'role="group" aria-label="pipelineの図"',
    );
  });

  test("draws the link of a step that has a job, so the label of the link is checked", () => {
    expect(draw("the flow diagram")).toContain(`href="/jobs/${DETAIL_ID}"`);
  });
});

describe("the detail screen in the coverage", () => {
  test("draws the overview, so the check does not pass on an empty screen", () => {
    expect(render(detailScreen())).toContain("概要");
  });
});
