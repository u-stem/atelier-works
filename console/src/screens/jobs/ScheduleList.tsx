import { Pause, Snowflake } from "lucide-react";
import { Link } from "react-router";
import type { HoldsSnapshot } from "../../api/guards/holds.ts";
import type {
  SchedulesSnapshotView,
  ScheduleViewData,
} from "../../api/jobsQueries.ts";
import type { SectionQuery } from "../../api/sectionQuery.ts";
import { useNow } from "../../app/useNow.ts";
import { JobLink } from "../../components/JobLink.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import {
  FLOWS_DATA,
  type FlowsData,
  flowDiagramPath,
  scheduleFlowsOf,
} from "../../lib/flowsData.ts";
import {
  deployHoldActive,
  type ScheduleFreeze,
  type ScheduleStopState,
  scheduleStopState,
} from "../../lib/holdPlace.ts";
import {
  describeSchedule,
  frozenScheduleTargets,
  jobsBackState,
  SCHEDULES_TRUNCATED_NOTE,
} from "../../lib/jobsView.ts";
import { safeText } from "../../lib/safeText.ts";
import { HoldPlaceDialog } from "../system/HoldPlaceDialog.tsx";
import { EmptyNote } from "../system/SystemSection.tsx";
import {
  initialPlaceForm,
  usePlaceHold,
  useScheduleRestore,
  useScheduleStop,
} from "../system/usePlacement.ts";
import {
  JobsQueryGate,
  SCHEDULE_LOADING_SHAPE,
  UpcomingTime,
} from "./JobRows.tsx";
import {
  ScheduleRestoreDialog,
  ScheduleStopControl,
  ScheduleStopDialog,
} from "./ScheduleStopActions.tsx";

const BACK = jobsBackState("?tab=schedules");

const FLOW_LINK_CLASS =
  "rounded-sm font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * scheduleの1行の説明と、起動するflowの図へのリンク。
 * データに無いscheduleは、何も出さない。flowを起動しないscheduleは、説明だけを出す。
 * 行全体はリンクにしない。止める操作と入れ子にならず、キーボードの順序を保つためである。
 */
function ScheduleFlows({
  path,
  flows,
}: {
  path: string;
  flows: FlowsData | null;
}) {
  const info = scheduleFlowsOf(flows, path);
  if (info === null) return null;
  const links = info.flows.flatMap((name) => {
    const to = flowDiagramPath(name, flows);
    return to === null ? [] : [{ name, to }];
  });
  return (
    <>
      <p className="text-small break-words">{safeText(info.summary)}</p>
      {links.length === 0 ? null : (
        <p className="flex flex-wrap items-center gap-x-2 text-small">
          <span className="text-muted-foreground">flowの図:</span>
          {links.map((link, index) => (
            <span key={link.name}>
              {index === 0 ? "" : "/ "}
              <Link to={link.to} state={BACK} className={FLOW_LINK_CLASS}>
                {safeText(link.name)}
              </Link>
            </span>
          ))}
        </p>
      )}
    </>
  );
}

function ScheduleRow({
  schedule,
  frozen,
  now,
  stop,
  locked,
  onPrepare,
  onStop,
  onRestore,
  flows,
}: {
  schedule: ScheduleViewData;
  flows: FlowsData | null;
  frozen: ReadonlySet<string> | null;
  now: number;
  stop: ScheduleStopState;
  locked: boolean;
  onPrepare: (path: string) => void;
  onStop: (path: string, freeze: ScheduleFreeze) => void;
  onRestore: (path: string, freeze: ScheduleFreeze) => void;
}) {
  const row = describeSchedule(schedule, frozen, now);
  return (
    <li className="flex flex-col gap-1.5 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 font-medium break-all">
          {safeText(row.name)}
        </span>
        <Badge variant={row.enabled ? "success" : "muted"}>
          {row.enabledLabel}
        </Badge>
        {row.frozen ? (
          <Badge variant="warning">
            <Snowflake aria-hidden="true" />
            凍結中
          </Badge>
        ) : null}
        {row.pausedLabel === null ? null : (
          <Badge variant="warning">
            <Pause aria-hidden="true" />
            {row.pausedLabel}
          </Badge>
        )}
        <span className="ml-auto">
          <ScheduleStopControl
            path={schedule.path}
            state={stop}
            locked={locked}
            onPrepare={onPrepare}
            onStop={onStop}
            onRestore={onRestore}
          />
        </span>
      </div>
      <ScheduleFlows path={schedule.path} flows={flows} />
      <p className="font-mono text-small break-all text-muted-foreground">
        {safeText(schedule.schedule)}
        <span className="font-sans"> ({safeText(schedule.timezone)})</span>
      </p>
      <p className="flex flex-wrap gap-x-4 gap-y-0.5 text-small text-muted-foreground tabular-nums">
        {row.nextRunAt === null ? (
          <span>次回の予定はありません</span>
        ) : (
          <span>
            <UpcomingTime iso={row.nextRunAt} now={now} prefix="次回 " />
          </span>
        )}
        {row.recentRuns.length === 0 ? (
          <span>実行の記録はありません</span>
        ) : (
          <span className="inline-flex flex-wrap items-center gap-x-3">
            直近
            {row.recentRuns.map((run) => (
              <span
                key={run.jobId}
                className="inline-flex items-center gap-x-1.5"
              >
                <JobLink jobId={run.jobId} label={run.label} state={BACK} />
                <span>{run.durationLabel}</span>
              </span>
            ))}
          </span>
        )}
      </p>
      {row.definitionNote === null ? null : (
        <p className="text-small break-words text-warning">
          {safeText(row.definitionNote)}
        </p>
      )}
      {row.error === null ? null : (
        <p className="overflow-hidden text-small break-words text-failure">
          {safeText(row.error)}
        </p>
      )}
    </li>
  );
}

/**
 * スケジュールのタブの本体。Windmillのscheduleの状態を、リポジトリの定義との差異と凍結を添えて並べる。
 * 凍結は、保留と凍結の取得(`console_holds`)の結果と突き合わせる。凍結を読めなかったときは、
 * 凍結が無いとは言わず、読めなかったと伝える。
 * 自動では取り直さず、画面の更新ボタンで取り直す。
 */
export function ScheduleList({
  schedules,
  holds,
  flows = FLOWS_DATA,
}: {
  schedules: SectionQuery<SchedulesSnapshotView>;
  holds: SectionQuery<HoldsSnapshot>;
  /** 説明と起動するflowのデータ。既定は同梱のデータ。 */
  flows?: FlowsData | null;
}) {
  const now = useNow();
  const frozen = frozenScheduleTargets(holds.data, now);
  const place = usePlaceHold();
  const stop = useScheduleStop();
  const restore = useScheduleRestore();
  const deployHeld = deployHoldActive(holds.data, now);
  return (
    <div className="flex max-w-4xl flex-col gap-3">
      <JobsQueryGate
        query={schedules}
        title="スケジュールを取得できませんでした"
        loginHint="上のバナーからログインすると、スケジュールを表示します。"
        shape={SCHEDULE_LOADING_SHAPE}
      >
        {(data) => (
          <>
            {data.truncated ? (
              <Alert variant="warning">
                <AlertDescription>
                  <p>{SCHEDULES_TRUNCATED_NOTE}</p>
                </AlertDescription>
              </Alert>
            ) : null}
            {frozen === null && !holds.isFetching ? (
              <Alert variant="warning">
                <AlertDescription>
                  <p>
                    凍結の状態を読めませんでした。凍結中のscheduleに印を付けられません。
                  </p>
                </AlertDescription>
              </Alert>
            ) : null}
            {data.missing_in_workspace.length === 0 ? null : (
              <Alert variant="warning">
                <AlertDescription>
                  <p>リポジトリにあり、Windmillに無いscheduleがあります。</p>
                  <ul className="list-inside list-disc break-all">
                    {data.missing_in_workspace.map((path) => (
                      <li key={path}>{safeText(path)}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}
            {data.schedules.length === 0 ? (
              <EmptyNote>scheduleはありません。</EmptyNote>
            ) : (
              <ul className="divide-y divide-border rounded-xl border border-border bg-card">
                {data.schedules.map((schedule) => {
                  const state = scheduleStopState(
                    schedule.path,
                    schedule.enabled,
                    holds.data,
                    now,
                  );
                  return (
                    <ScheduleRow
                      key={schedule.path}
                      flows={flows}
                      schedule={schedule}
                      frozen={frozen}
                      now={now}
                      stop={state}
                      locked={
                        place.isFreezeLocked(schedule.path) ||
                        stop.isLocked(schedule.path) ||
                        (state.kind === "stopped" &&
                          restore.isLocked(state.freeze.id))
                      }
                      onPrepare={(path) => {
                        place.begin("stop_prepare", path);
                      }}
                      onStop={stop.choose}
                      onRestore={restore.choose}
                    />
                  );
                })}
              </ul>
            )}
          </>
        )}
      </JobsQueryGate>
      <HoldPlaceDialog
        open={place.dialog !== null}
        variant={place.dialog?.variant ?? "stop_prepare"}
        form={place.dialog?.form ?? initialPlaceForm("stop_prepare")}
        onChange={place.change}
        onConfirm={place.confirm}
        onCancel={place.dismiss}
      />
      <ScheduleStopDialog
        target={stop.target}
        deployHoldActive={deployHeld}
        onConfirm={stop.confirm}
        onCancel={stop.dismiss}
      />
      <ScheduleRestoreDialog
        target={restore.target}
        deployHoldActive={deployHeld}
        onConfirm={restore.confirm}
        onCancel={restore.dismiss}
      />
    </div>
  );
}
