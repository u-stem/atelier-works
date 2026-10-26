import { Snowflake } from "lucide-react";
import type { HoldsSnapshot } from "../../api/guards/holds.ts";
import type {
  SchedulesSnapshotView,
  ScheduleViewData,
} from "../../api/jobsQueries.ts";
import type { SectionQuery } from "../../api/sectionQuery.ts";
import { useNow } from "../../app/useNow.ts";
import { JobLink } from "../../components/JobLink.tsx";
import { TimeText } from "../../components/TimeText.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import {
  describeSchedule,
  frozenScheduleTargets,
  jobsBackState,
  SCHEDULES_TRUNCATED_NOTE,
} from "../../lib/jobsView.ts";
import { EmptyNote } from "../system/SystemSection.tsx";
import { JobsQueryGate, LIST_LOADING_SHAPE } from "./JobRows.tsx";

const BACK = jobsBackState("?tab=schedules");

function ScheduleRow({
  schedule,
  frozen,
  now,
}: {
  schedule: ScheduleViewData;
  frozen: ReadonlySet<string> | null;
  now: number;
}) {
  const row = describeSchedule(schedule, frozen);
  return (
    <li className="flex flex-col gap-1.5 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 font-medium break-all">{row.name}</span>
        <Badge variant={row.enabled ? "success" : "muted"}>
          {row.enabledLabel}
        </Badge>
        {row.frozen ? (
          <Badge variant="warning">
            <Snowflake aria-hidden="true" />
            凍結中
          </Badge>
        ) : null}
      </div>
      <p className="font-mono text-small break-all text-muted-foreground">
        {schedule.schedule}
        <span className="font-sans"> ({schedule.timezone})</span>
      </p>
      <p className="flex flex-wrap gap-x-4 gap-y-0.5 text-small text-muted-foreground tabular-nums">
        {row.nextRunAt === null ? (
          <span>次回の予定はありません</span>
        ) : (
          <span>
            <TimeText iso={row.nextRunAt} now={now} prefix="次回 " />
          </span>
        )}
        {row.lastRun === null ? (
          <span>実行の記録はありません</span>
        ) : (
          <span className="inline-flex flex-wrap items-center gap-x-2">
            直近
            <JobLink
              jobId={row.lastRun.jobId}
              label={row.lastRun.label}
              state={BACK}
            />
            <span>{row.lastRun.durationLabel}</span>
          </span>
        )}
      </p>
      {row.definitionNote === null ? null : (
        <p className="text-small text-warning">{row.definitionNote}</p>
      )}
      {row.error === null ? null : (
        <p className="text-small break-words text-failure">{row.error}</p>
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
}: {
  schedules: SectionQuery<SchedulesSnapshotView>;
  holds: SectionQuery<HoldsSnapshot>;
}) {
  const now = useNow();
  const frozen = frozenScheduleTargets(holds.data, now);
  return (
    <div className="flex max-w-4xl flex-col gap-3">
      <p className="text-small text-muted-foreground">
        Windmillのscheduleの状態です。有効か無効か、次回の予定、直近の実行、凍結されているかを示し、定義と違う項目があれば添えます。自動では更新しません。
      </p>
      <JobsQueryGate
        query={schedules}
        title="スケジュールを取得できませんでした"
        loginHint="上のバナーからログインすると、スケジュールを表示します。"
        shape={LIST_LOADING_SHAPE}
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
                      <li key={path}>{path}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}
            {data.schedules.length === 0 ? (
              <EmptyNote>scheduleはありません。</EmptyNote>
            ) : (
              <ul className="divide-y divide-border rounded-xl border border-border bg-card">
                {data.schedules.map((schedule) => (
                  <ScheduleRow
                    key={schedule.path}
                    schedule={schedule}
                    frozen={frozen}
                    now={now}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </JobsQueryGate>
    </div>
  );
}
