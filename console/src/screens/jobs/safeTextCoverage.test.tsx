// サーバー由来の文字列のすべての項目に、見えない文字を入れて描き、画面に残らないことを確かめる。
// 項目を足したときに無害化を忘れると、ここで落ちる。
// ソースの検査は`tests/scripts/console_jobs_render_contract.test.ts`が行う。

import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { freshQuery } from "../../api/fakeSectionQuery.testing.ts";
import type { HoldsSnapshot } from "../../api/guards/holds.ts";
import type {
  JobSummaryView,
  ScheduleViewData,
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
import { JobHistory } from "./JobHistory.tsx";
import { JobList, JobStateBadge } from "./JobRows.tsx";
import { ScheduleList } from "./ScheduleList.tsx";

/** 並びを入れ替える文字と、ANSIの開始の文字を含む文字列。 */
const BAD = "a‮b\u001b[31mc";

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

const CASES: readonly (readonly [string, () => ReactElement])[] = [
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
  [
    "the script options of the history",
    () => (
      <JobHistory
        history={{
          pages: [],
          first: freshQuery({
            view: "history",
            jobs: [],
            next_before: null,
            filter_rejected: false,
            truncated: false,
          }),
          more: null,
          canLoadMore: false,
          loadMore: () => undefined,
          refresh: () => undefined,
        }}
        status={undefined}
        script={undefined}
        scripts={[`f/factory/${BAD}`]}
        onStatusChange={() => undefined}
        onScriptChange={() => undefined}
        search=""
      />
    ),
  ],
];

describe("every string of the server is sanitized when it is drawn", () => {
  test.each(CASES)("in %s", (_name, element) => {
    const html = render(element());
    expect(html.includes("‮") || html.includes("\u001b")).toBe(false);
  });

  test.each(CASES)("and %s still draws something", (_name, element) => {
    expect(render(element()).length).toBeGreaterThan(20);
  });
});
