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
import { ConfigList } from "../system/ConfigSection.tsx";
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
    <TooltipProvider>
      <MemoryRouter>{element}</MemoryRouter>
    </TooltipProvider>,
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
    steps: [{ id: BAD, state: BAD, job_id: BAD, iterations: null }],
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
        steps={[{ id: BAD, state: BAD, job_id: BAD, iterations: null }]}
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

describe("the detail screen in the coverage", () => {
  test("draws the overview, so the check does not pass on an empty screen", () => {
    expect(render(detailScreen())).toContain("概要");
  });
});
