import type { ReactNode } from "react";
import { Link } from "react-router";
import type {
  ArgViewData,
  JobDetailView,
  JobSummaryView,
  OutputViewData,
  StepViewData,
} from "../../api/jobsQueries.ts";
import { JobLink, WindmillJobLink } from "../../components/JobLink.tsx";
import { TimeText } from "../../components/TimeText.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { displayableIssueText } from "../../lib/intakeText.ts";
import {
  describeArg,
  formatDuration,
  outputNotes,
  stepIterationsLabel,
} from "../../lib/jobsView.ts";
import { workItemRef } from "../../lib/labels.ts";
import { itemDetailPath } from "../../lib/pipelineView.ts";
import { JobStateBadge, UpcomingTime } from "./JobRows.tsx";

/** 詳細のパンくずが、一覧の範囲へ戻るための履歴の`state`。 */
export type BackState = { readonly jobsBack: string } | undefined;

const LINK_CLASS =
  "rounded-sm font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** 詳細の1つの節。見出しは節の名前を持つ。 */
export function DetailSection({
  id,
  title,
  actions,
  children,
}: {
  id: string;
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex max-w-4xl flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="text-lead font-semibold">
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all tabular-nums">{children}</dd>
    </>
  );
}

/**
 * ジョブの概要。状態、script、時刻、所要時間、親のジョブ、関連する作業項目を並べる。
 * 作業項目へのリンクは、正の整数のidから組み立てる。
 * Windmillの画面への副次のリンクは、Consoleの詳細で足りないときの逃げ道として小さく添える。
 */
export function JobOverview({
  job,
  now,
  relatedItemId,
  back,
}: {
  job: JobSummaryView;
  now: number;
  relatedItemId: number | null;
  back: BackState;
}) {
  return (
    <div className="flex flex-col gap-2">
      <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-small">
        <Row label="状態">
          <JobStateBadge state={job.state} />
        </Row>
        <Row label="script">
          <span className="font-mono">{job.script_path}</span>
        </Row>
        <Row label="種類">{job.job_kind === "flow" ? "flow" : "script"}</Row>
        {job.created_at === null ? null : (
          <Row label="登録">
            <TimeText iso={job.created_at} now={now} />
          </Row>
        )}
        {job.scheduled_for === null ? null : (
          <Row label="予定">
            <UpcomingTime iso={job.scheduled_for} now={now} />
          </Row>
        )}
        {job.started_at === null ? null : (
          <Row label="開始">
            <TimeText iso={job.started_at} now={now} />
          </Row>
        )}
        {job.completed_at === null ? null : (
          <Row label="完了">
            <TimeText iso={job.completed_at} now={now} />
          </Row>
        )}
        <Row label="所要時間">{formatDuration(job.duration_ms)}</Row>
        {job.schedule_path === null ? null : (
          <Row label="スケジュール">{job.schedule_path}</Row>
        )}
        {job.parent_job === null ? null : (
          <Row label="親のジョブ">
            <JobLink
              jobId={job.parent_job}
              label="親のジョブを開く"
              state={back}
            />
          </Row>
        )}
        {relatedItemId === null ? null : (
          <Row label="作業項目">
            <Link to={itemDetailPath(relatedItemId)} className={LINK_CLASS}>
              {workItemRef(relatedItemId)}
            </Link>
          </Row>
        )}
      </dl>
      <p className="text-caption">
        <WindmillJobLink jobId={job.id} label="Windmillで開く" />
      </p>
    </div>
  );
}

/**
 * 引数の一覧。値を出してよい引数だけ値を出し、それ以外はキーと型だけを出す。
 * 値は文字列のノードとして描く。
 */
export function ArgList({ args }: { args: readonly ArgViewData[] }) {
  if (args.length === 0) {
    return (
      <p className="text-small text-muted-foreground">引数はありません。</p>
    );
  }
  return (
    <dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-xl border border-border bg-card px-4 py-3 text-small">
      {args.map((arg) => {
        const text = describeArg(arg);
        return (
          <Row key={arg.key} label={text.key}>
            {text.value === null ? (
              <span className="text-muted-foreground">
                値は表示しません(型: {text.type})
              </span>
            ) : (
              <span className="font-mono">
                {displayableIssueText(text.value).text}
              </span>
            )}
          </Row>
        );
      })}
    </dl>
  );
}

/**
 * フローのステップの一覧。モジュールのid、状態、繰り返しの回数を出し、子のジョブの詳細へ移れる。
 * ルートのジョブのログは短く、ステップの出力は子のジョブにあるためである。
 */
export function StepList({
  steps,
  back,
}: {
  steps: readonly StepViewData[];
  back: BackState;
}) {
  return (
    <ol className="divide-y divide-border rounded-xl border border-border bg-card">
      {steps.map((step) => {
        const iterations = stepIterationsLabel(step.iterations);
        return (
          <li
            key={step.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-small"
          >
            <span className="min-w-0 font-mono break-all">{step.id}</span>
            <JobStateBadge state={step.state} />
            {iterations === null ? null : (
              <span className="text-muted-foreground">{iterations}</span>
            )}
            <JobLink
              jobId={step.job_id}
              label="ログと結果を見る"
              state={back}
            />
          </li>
        );
      })}
    </ol>
  );
}

/**
 * ログか結果の節。本文はテキストのノードとして`<pre>`に描く。
 * Markdown、HTML、ANSIの解釈、自動のリンクは使わない。出力には、defaultのworkerで動いたscriptの出力が含まれうるためである。
 * 見えない文字と、並びの見た目を入れ替える文字は、代替文字にしてから描く。
 * 伏せ字の限界、伏せた、切った、JSONでない行があることを、注記で伝える。
 * `onRefresh`を渡すと、取り直す操作を見出しの横に置く。ログは、この操作のときだけ取り直す。
 */
export function OutputSection({
  id,
  title,
  kind,
  output,
  error,
  emptyText,
  onRefresh,
  refreshLabel = "更新",
  refreshing = false,
}: {
  id: string;
  title: string;
  kind: "log" | "result";
  output: (OutputViewData & { readonly nonJsonLines?: number }) | null;
  /** 結果を読めなかった理由。 */
  error: string | null;
  emptyText: string;
  onRefresh?: () => void;
  refreshLabel?: string;
  refreshing?: boolean;
}) {
  return (
    <DetailSection
      id={id}
      title={title}
      actions={
        onRefresh === undefined ? null : (
          <Button
            size="sm"
            variant="outline"
            aria-disabled={refreshing}
            onClick={refreshing ? undefined : onRefresh}
          >
            {refreshLabel}
          </Button>
        )
      }
    >
      {output === null ? null : (
        <ul className="flex flex-col gap-0.5 text-small text-muted-foreground">
          {outputNotes(kind, output).map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      {error === null ? null : (
        <Alert variant="warning">
          <AlertDescription>
            <p>結果を読めませんでした。</p>
            <p className="break-words">{displayableIssueText(error).text}</p>
          </AlertDescription>
        </Alert>
      )}
      {output === null || output.text === "" ? (
        error === null ? (
          <p className="text-small text-muted-foreground">{emptyText}</p>
        ) : null
      ) : (
        <section
          // スクロールできる領域は、キーボードで焦点を当てないと読み進められない。
          // biome-ignore lint/a11y/noNoninteractiveTabindex: 同上。
          tabIndex={0}
          aria-label={title}
          className="max-h-[32rem] overflow-auto rounded-lg border border-border bg-muted/40 p-3 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <pre className="font-mono text-small break-words whitespace-pre-wrap">
            {displayableIssueText(output.text).text}
          </pre>
        </section>
      )}
    </DetailSection>
  );
}

/**
 * 失敗の検知が保存した原因。実行のログと別に、検知の時点で伏せて保存した文を出す。
 * 読めなかったときは、原因の欄だけが失敗を示し、詳細の全体は出す。
 */
export function FailureCauses({
  failures,
  now,
  back,
}: {
  failures: Extract<JobDetailView, { found: true }>["failures"];
  now: number;
  back: BackState;
}) {
  if (!failures.ok) {
    return (
      <Alert variant="warning">
        <AlertDescription>
          <p>保存された原因を読めませんでした。</p>
          <p className="break-words">
            {displayableIssueText(failures.reason).text}
          </p>
        </AlertDescription>
      </Alert>
    );
  }
  if (failures.items.length === 0) {
    return (
      <p className="text-small text-muted-foreground">
        保存された失敗の原因はありません。
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border rounded-xl border border-border bg-card">
      {failures.items.map((item) => (
        <li
          key={`${item.occurred_at}-${item.step ?? ""}-${item.job_id ?? ""}`}
          className="flex flex-col gap-1.5 px-4 py-3 text-small"
        >
          <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-muted-foreground">
            <span className="font-medium text-foreground">
              {item.step === null ? "ジョブ全体" : `ステップ ${item.step}`}
            </span>
            <TimeText iso={item.occurred_at} now={now} />
            <JobLink
              jobId={item.job_id}
              label="このジョブの詳細"
              state={back}
            />
          </p>
          <p className="break-words whitespace-pre-wrap">
            {displayableIssueText(item.error).text}
          </p>
        </li>
      ))}
    </ul>
  );
}
