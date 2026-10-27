import {
  Ban,
  CalendarClock,
  CircleCheck,
  CircleQuestionMark,
  CircleX,
  Clock,
  LoaderCircle,
  type LucideIcon,
  SkipForward,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type {
  ActiveJobStepsView,
  JobListView,
  JobSummaryView,
} from "../../api/jobsQueries.ts";
import { loadPhaseOf, type SectionQuery } from "../../api/sectionQuery.ts";
import { useNow } from "../../app/useNow.ts";
import {
  LoadingGate,
  type LoadingShape,
} from "../../components/LoadingState.tsx";
import { StaleDataNotice } from "../../components/StaleDataNotice.tsx";
import { TimeText } from "../../components/TimeText.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { Badge, type BadgeProps } from "../../components/ui/badge.tsx";
import {
  preferDetailState,
  type StepDetails,
  type StepLine,
  stepLinesOf,
} from "../../lib/activeSteps.ts";
import { cn } from "../../lib/cn.ts";
import { jobDetailPath } from "../../lib/jobLink.ts";
import {
  ACTIVE_TRUNCATED_NOTE,
  currentJobs,
  formatDuration,
  type JobStateInfo,
  type JobStateKind,
  jobScriptName,
  jobStateInfo,
  jobsBackState,
  stepStateInfo,
  upcomingLabel,
} from "../../lib/jobsView.ts";
import { safeText } from "../../lib/safeText.ts";
import { QueryFailure } from "../items/QueryFailure.tsx";
import { EmptyNote } from "../system/SystemSection.tsx";

/** 状態の記号と色。記号の形でも状態を見分けられるようにし、色だけに頼らない。 */
const STATE_STYLE: Readonly<
  Record<
    JobStateKind,
    { Icon: LucideIcon; variant: BadgeProps["variant"]; spin?: boolean }
  >
> = {
  success: { Icon: CircleCheck, variant: "success" },
  failure: { Icon: CircleX, variant: "failure" },
  running: { Icon: LoaderCircle, variant: "notice", spin: true },
  queued: { Icon: Clock, variant: "muted" },
  scheduled: { Icon: CalendarClock, variant: "muted" },
  canceled: { Icon: Ban, variant: "warning" },
  skipped: { Icon: SkipForward, variant: "outline" },
  unknown: { Icon: CircleQuestionMark, variant: "outline" },
};

/** 状態の記号と語。実行中の記号は回す。動きを減らす設定の利用者には、index.cssの規則が回転を止める。 */
function StateBadge({ info }: { info: JobStateInfo }) {
  const { Icon, variant, spin } = STATE_STYLE[info.kind];
  return (
    <Badge variant={variant}>
      <Icon
        aria-hidden="true"
        className={cn(spin === true && "animate-spin")}
      />
      {info.label}
    </Badge>
  );
}

/** ジョブの状態。記号と語を並べる。 */
export function JobStateBadge({ state }: { state: string }) {
  return <StateBadge info={jobStateInfo(state)} />;
}

/**
 * ステップの状態。記号と語を並べる。
 * ジョブ詳細のステップの一覧と、一覧の今のステップが共有する。条件で飛ばしたステップは「スキップ」と示す。
 */
export function StepStateBadge({
  state,
  skipped,
}: {
  state: string;
  skipped: boolean;
}) {
  return <StateBadge info={stepStateInfo({ state, skipped })} />;
}

/**
 * これから来る時刻。「10/26 14:05(残り5分)」の形で出す。
 * 相対時刻の共通の表示は未来を「たった今」とするので、予定の時刻には使わない。
 */
export function UpcomingTime({
  iso,
  now,
  prefix = "",
}: {
  iso: string;
  now: number;
  prefix?: string;
}) {
  return (
    <time dateTime={iso} className="tabular-nums">
      {prefix}
      {upcomingLabel(iso, now)}
    </time>
  );
}

/** 一覧の1行に添える時刻。実行中と待ちの一覧は状態に合う時刻を、履歴は完了の時刻を出す。 */
function timeOf(
  job: JobSummaryView,
  time: "active" | "history",
): { iso: string; prefix: string } | null {
  if (time === "history") {
    return job.completed_at === null
      ? null
      : { iso: job.completed_at, prefix: "完了 " };
  }
  if (job.state === "running" && job.started_at !== null) {
    return { iso: job.started_at, prefix: "開始 " };
  }
  return job.created_at === null
    ? null
    : { iso: job.created_at, prefix: "登録 " };
}

/**
 * 実行中のflowの行に添える、今のステップの1行。
 * ステップの状態は、ジョブ詳細のステップの一覧と同じ語で示す。
 * 取得に失敗したときは、ステップが無いとは言わず、読めなかったと伝える。
 */
function StepLineView({ line }: { line: StepLine }) {
  if (line.kind === "unreadable") {
    return (
      <p className="text-small text-muted-foreground">
        今のステップを読めませんでした
      </p>
    );
  }
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-muted-foreground">
      <span>今のステップ</span>
      <span className="min-w-0 font-mono break-all text-foreground">
        {safeText(line.step.id)}
      </span>
      <StepStateBadge state={line.step.state} skipped={line.step.skipped} />
    </p>
  );
}

function JobRow({
  job,
  now,
  back,
  time,
  stepLine,
}: {
  job: JobSummaryView;
  now: number;
  back: string;
  time: "active" | "history";
  stepLine: StepLine | undefined;
}) {
  const to = jobDetailPath(job.id);
  const name = safeText(jobScriptName(job.script_path));
  const at = timeOf(job, time);
  return (
    <li className="flex flex-col gap-1 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <JobStateBadge state={job.state} />
        {to === null ? (
          <span className="min-w-0 font-medium break-all">{name}</span>
        ) : (
          <Link
            to={to}
            state={jobsBackState(back)}
            className="min-w-0 rounded-sm font-medium break-all underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {name}
          </Link>
        )}
        {job.job_kind === "flow" ? (
          <span className="text-caption text-subtle">flow</span>
        ) : null}
      </div>
      <p className="flex flex-wrap gap-x-4 gap-y-0.5 text-small text-muted-foreground tabular-nums">
        {at === null ? null : (
          <span>
            <TimeText iso={at.iso} now={now} prefix={at.prefix} />
          </span>
        )}
        {job.duration_ms === null ? null : (
          <span>所要 {formatDuration(job.duration_ms)}</span>
        )}
        {job.schedule_path === null ? null : (
          <span className="break-all">
            スケジュール {safeText(jobScriptName(job.schedule_path))}
          </span>
        )}
      </p>
      {stepLine === undefined ? null : <StepLineView line={stepLine} />}
    </li>
  );
}

/**
 * ジョブの行の並び。1行ごとに、状態、scriptの名前(詳細へのリンク)、時刻、所要時間を出す。
 * 幅の狭い画面でも読めるよう、表でなく折り返す行にする。
 * `back`は一覧の`location.search`で、詳細のパンくずが同じ範囲の一覧へ戻るために、リンクの`state`へ入れる。
 */
export function JobList({
  jobs,
  now,
  back,
  time,
  stepLines,
}: {
  jobs: readonly JobSummaryView[];
  now: number;
  back: string;
  time: "active" | "history";
  /** 実行中のflowの行に添える今のステップ。ジョブのidで引く。 */
  stepLines?: ReadonlyMap<string, StepLine>;
}) {
  return (
    <ul className="divide-y divide-border rounded-xl border border-border bg-card">
      {jobs.map((job) => (
        <JobRow
          key={job.id}
          job={job}
          now={now}
          back={back}
          time={time}
          stepLine={
            job.job_kind === "flow" ? stepLines?.get(job.id) : undefined
          }
        />
      ))}
    </ul>
  );
}

/**
 * 一覧の取得の状態を出し分ける。取得中は枠、失敗して値が無いときは失敗の表示、
 * 前の値があって取り直しに失敗したときは、値を出したまま古いことを添える。
 */
export function JobsQueryGate<T>({
  query,
  title,
  loginHint,
  shape,
  children,
}: {
  query: SectionQuery<T>;
  /** 取得できなかったものを指す題。 */
  title: string;
  loginHint: string;
  shape: LoadingShape;
  children: (data: T) => ReactNode;
}) {
  return (
    <LoadingGate phase={loadPhaseOf(query)} shape={shape}>
      {query.data === undefined ? (
        <QueryFailure
          compact
          title={title}
          loginHint={loginHint}
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : (
        <>
          {query.isError ? (
            <StaleDataNotice
              isFetching={query.isFetching}
              error={query.error}
              onRetry={() => {
                void query.refetch();
              }}
            />
          ) : null}
          {children(query.data)}
        </>
      )}
    </LoadingGate>
  );
}

/** 読み込み中の形。1行は約3.5remで、よくある件数に合わせる。実機で測り直す。 */
export const LIST_LOADING_SHAPE: LoadingShape = {
  rows: 5,
  rowClassName: "h-14 w-full rounded-md",
  gapClassName: "gap-2",
};

export const JOB_LIST_LOADING_SHAPE: LoadingShape = LIST_LOADING_SHAPE;
export const SCHEDULE_LOADING_SHAPE: LoadingShape = LIST_LOADING_SHAPE;

/**
 * 実行中と待ちのタブの本体。実行中と、workerを待つジョブを並べる。
 * これから始まる予定のジョブは並べない。次回の予定は、スケジュールのタブに同じ情報があるためである。
 * 並べないものの注記は置かない。スケジュールのタブは隣にあり、tag consoleの除外は運用の文書にある。
 * キューが切れていて0件のときは、読めた範囲のことだと分かる文にする。切れた先に動いているジョブがありうるためである。
 * 自動では取り直さず、画面の更新ボタンで取り直す。その案内は見出しの更新の脇に任せ、ここでは繰り返さない。
 * キューの1ページで切れたときは、全件を読めていないと伝える。
 */
export function ActiveJobs({
  query,
  steps,
}: {
  query: SectionQuery<JobListView>;
  /** 実行中のflowの今のステップ。渡さなければ、行にステップを添えない。 */
  steps?: ActiveJobStepsView;
}) {
  const now = useNow();
  return (
    <div className="flex max-w-4xl flex-col gap-3">
      <JobsQueryGate
        query={query}
        title="実行中と待ちのジョブを取得できませんでした"
        loginHint="上のバナーからログインすると、実行中と待ちのジョブを表示します。"
        shape={LIST_LOADING_SHAPE}
      >
        {(data) => {
          const details: StepDetails = steps?.details ?? new Map();
          const jobs = preferDetailState(currentJobs(data.jobs), details);
          return (
            <>
              {data.truncated ? (
                <Alert variant="warning">
                  <AlertDescription>
                    <p>{ACTIVE_TRUNCATED_NOTE}</p>
                  </AlertDescription>
                </Alert>
              ) : null}
              {jobs.length === 0 ? (
                <EmptyNote>
                  {data.truncated
                    ? "読めた範囲では、実行中・待ちのジョブはありません。"
                    : "いま実行中・待ちのジョブはありません。"}
                </EmptyNote>
              ) : (
                <JobList
                  jobs={jobs}
                  now={now}
                  back=""
                  time="active"
                  stepLines={stepLinesOf(jobs, details)}
                />
              )}
            </>
          );
        }}
      </JobsQueryGate>
    </div>
  );
}
