// 取り消せない操作の確認ダイアログを、開いた形で描いて、自前のa11y規則で検査する。
// 静的な描画では`showModal`が呼ばれないので、`open`属性を足して開いた形にする。
// 閉じた`<dialog>`の中は規則の対象外なので、開かないと中身を検査できない。
// 要対応の承認と却下の確認は、要対応の画面の選択(`a11yScreens.test.tsx`)で検査する。

import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  DeployFreezeRowView,
  FreezeRowView,
  HoldRowView,
} from "./api/guards/holds.ts";
import type { SummaryFailure } from "./api/guards/summary.ts";
import type { JobSummaryView } from "./api/jobsQueries.ts";
import { ConfirmDialog } from "./components/ConfirmDialog.tsx";
import { type A11yViolation, checkA11y } from "./lib/a11yRules.ts";
import { changeOfferOf } from "./lib/configChange.ts";
import { describeFailure, describeRetryPlan } from "./lib/failureView.ts";
import type { PlaceForm, ScheduleFreeze } from "./lib/holdPlace.ts";
import {
  deployFreezeItems,
  type HoldItem,
  holdItems,
  scheduleFreezeItems,
} from "./lib/holdsView.ts";
import { RetryConfirmDialog } from "./screens/inbox/RetryConfirmDialog.tsx";
import { CancelDialog, RerunDialog } from "./screens/jobs/JobActions.tsx";
import {
  ScheduleRestoreDialog,
  ScheduleStopDialog,
} from "./screens/jobs/ScheduleStopActions.tsx";
import { KickoffConfirmDialog } from "./screens/reports/KickoffConfirmDialog.tsx";
import { ConfigChangeDialog } from "./screens/system/ConfigChangeDialog.tsx";
import { HoldPlaceDialog } from "./screens/system/HoldPlaceDialog.tsx";
import { HoldReleaseDialog } from "./screens/system/HoldReleaseDialog.tsx";

const NOW = Date.parse("2026-10-24T03:00:00.000Z");
const T0 = "2026-10-24T02:00:00.000Z";
const T1 = "2026-10-24T04:00:00.000Z";
const NOOP = (): void => undefined;

const HOLD: HoldRowView = {
  id: 12,
  scope: "merge",
  target: "octo/repo",
  reason: "wait for the release",
  holder_kind: "session",
  holder: "session:feat/x",
  created_at: T0,
  expires_at: T1,
};

const SCHEDULE: FreezeRowView = {
  id: "0a1b2c3d",
  target: "f/factory/poll_issues",
  reason: "verify the schedule",
  holder_kind: "human",
  holder: "human",
  created_at: T0,
  expires_at: T1,
};

const DEPLOY: DeployFreezeRowView = {
  id: "1b2c3d4e",
  reason: "migration window",
  holder_kind: "human",
  holder: "human",
  created_at: T0,
  expires_at: T1,
};

const FORM: PlaceForm = {
  kind: "merge",
  target: "octo-owner/widgets",
  minutesText: "60",
  reason: "check the workers",
};

const FREEZE: ScheduleFreeze = {
  id: "0a1b2c3d",
  createdAt: "2026-10-27T03:00:00.000Z",
  expiresAt: "2026-10-27T05:00:00.000Z",
};

const JOB: JobSummaryView = {
  id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
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
};

const FAILURE: SummaryFailure = {
  work_item_id: 2,
  kind: "issue",
  owner: "o",
  repo: "r",
  issue_number: 2,
  issue_url: null,
  pr_number: null,
  title: "failed item",
  status: "failed",
  updated_at: T0,
  status_note: null,
  status_changed_at: null,
  job_failure_id: 1,
  flow_path: "f/factory/example",
  job_id: JOB.id,
  step: "a",
  error: "boom",
  occurred_at: T0,
};

function offerFor(key: string, value: unknown) {
  const offer = changeOfferOf({ key, kind: "value", value, masked: false });
  if (offer === null) {
    throw new Error(`no offer for ${key}`);
  }
  return offer;
}

function releaseOf(item: HoldItem | undefined): ReactElement {
  return (
    <HoldReleaseDialog
      item={item ?? null}
      now={NOW}
      otherDeployCount={1}
      busy={false}
      onConfirm={NOOP}
      onCancel={NOOP}
    />
  );
}

type Draw = () => ReactElement;

const CASES: readonly (readonly [string, Draw])[] = [
  [
    "the place dialog for any kind",
    () => (
      <HoldPlaceDialog
        open
        variant="any"
        form={FORM}
        onChange={NOOP}
        onConfirm={NOOP}
        onCancel={NOOP}
      />
    ),
  ],
  [
    "the place dialog for the stop preparation",
    () => (
      <HoldPlaceDialog
        open
        variant="stop_prepare"
        form={FORM}
        onChange={NOOP}
        onConfirm={NOOP}
        onCancel={NOOP}
      />
    ),
  ],
  ["the removal dialog for a hold", () => releaseOf(holdItems([HOLD])[0])],
  [
    "the removal dialog for a schedule freeze",
    () => releaseOf(scheduleFreezeItems([SCHEDULE])[0]),
  ],
  [
    "the removal dialog for a deploy freeze",
    () => releaseOf(deployFreezeItems([DEPLOY])[0]),
  ],
  [
    "the config change dialog for a switch",
    () => (
      <ConfigChangeDialog
        offer={offerFor("implement_enabled", true)}
        text=""
        onTextChange={NOOP}
        onConfirm={NOOP}
        onCancel={NOOP}
      />
    ),
  ],
  [
    "the config change dialog for a number",
    () => (
      <ConfigChangeDialog
        offer={offerFor("daily_budget_usd", 50)}
        text="40"
        onTextChange={NOOP}
        onConfirm={NOOP}
        onCancel={NOOP}
      />
    ),
  ],
  [
    "the audit kickoff dialog",
    () => <KickoffConfirmDialog open onConfirm={NOOP} onCancel={NOOP} />,
  ],
  [
    "the job cancel dialog",
    () => (
      <CancelDialog job={JOB} workItemId={7} onConfirm={NOOP} onCancel={NOOP} />
    ),
  ],
  [
    "the job rerun dialog",
    () => <RerunDialog job={JOB} onConfirm={NOOP} onCancel={NOOP} />,
  ],
  [
    "the schedule stop dialog",
    () => (
      <ScheduleStopDialog
        target={{ path: "f/factory/poll_prs", freeze: FREEZE }}
        deployHoldActive={false}
        onConfirm={NOOP}
        onCancel={NOOP}
      />
    ),
  ],
  [
    "the schedule restore dialog",
    () => (
      <ScheduleRestoreDialog
        target={{ path: "f/factory/poll_prs", freeze: FREEZE }}
        deployHoldActive
        onConfirm={NOOP}
        onCancel={NOOP}
      />
    ),
  ],
  [
    "the retry dialog",
    () => (
      <RetryConfirmDialog
        open
        description={describeFailure(FAILURE)}
        plan={describeRetryPlan(FAILURE)}
        now={NOW}
        onConfirm={NOOP}
        onCancel={NOOP}
      />
    ),
  ],
  [
    "the shared confirm dialog with a destructive confirmation",
    () => (
      <ConfirmDialog
        open
        title="確認"
        confirmLabel="実行する"
        destructive
        onConfirm={NOOP}
        onCancel={NOOP}
      >
        <p>本文</p>
      </ConfirmDialog>
    ),
  ],
];

function drawnOpen(element: ReactElement): string {
  return renderToStaticMarkup(element).replaceAll("<dialog ", "<dialog open ");
}

function violations(draw: Draw): string[] {
  return checkA11y(drawnOpen(draw()), { headingStart: 1 }).map(
    (violation: A11yViolation) => `${violation.rule}: ${violation.message}`,
  );
}

describe("a11y: the confirmation dialogs, drawn open", () => {
  test.each(CASES)("%s has no violations", (_name, draw) => {
    expect(violations(draw)).toEqual([]);
  });

  test("a dialog drawn open really draws its content", () => {
    const [first] = CASES;
    expect(first === undefined ? "" : drawnOpen(first[1]())).toContain(
      "保留か凍結を置きますか",
    );
  });
});
