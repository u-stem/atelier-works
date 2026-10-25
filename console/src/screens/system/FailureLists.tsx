import { Link } from "react-router";
import type { SummaryFailure } from "../../api/guards/summary.ts";
import type { SystemOrphanFailure } from "../../api/guards/systemStatus.ts";
import { JobLink } from "../../components/JobLink.tsx";
import { Pagination } from "../../components/Pagination.tsx";
import { TimeText } from "../../components/TimeText.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import {
  describeFailure,
  FAILURE_TEXT_LIMIT,
  workItemPath,
} from "../../lib/failureView.ts";
import { pageSlice } from "../../lib/pagination.ts";
import { describeOrphanFailure } from "../../lib/systemView.ts";
import { usePagination } from "../../lib/usePagination.ts";
import { EmptyNote } from "./SystemSection.tsx";

/** 1ページに出す失敗の数。 */
const PAGE_SIZE = 10;

const LINK_CLASS =
  "rounded-sm font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring";

function ErrorText({ text, truncated }: { text: string; truncated: boolean }) {
  return (
    <>
      <pre
        dir="ltr"
        className="mt-2 max-h-72 overflow-auto rounded-lg bg-muted px-4 py-3 font-mono text-small break-words whitespace-pre-wrap text-foreground [unicode-bidi:isolate]"
      >
        {text}
      </pre>
      {truncated ? (
        <p className="mt-1 text-small text-warning">
          先頭の{FAILURE_TEXT_LIMIT}
          字だけを表示しています。全文はジョブのログで確かめられます。
        </p>
      ) : null}
    </>
  );
}

function AuditFailureItem({
  failure,
  now,
}: {
  failure: SummaryFailure;
  now: number;
}) {
  const description = describeFailure(failure);
  return (
    <li className="rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Link
          to={workItemPath(failure.work_item_id)}
          className={`${LINK_CLASS} text-body break-words`}
        >
          {description.title}
        </Link>
        <Badge variant={description.statusTone}>
          {description.statusLabel}
        </Badge>
        <span className="text-small text-subtle">
          <TimeText
            iso={description.occurredAt}
            now={now}
            prefix={`${description.occurredLabel} `}
          />
        </span>
        <JobLink jobId={description.jobId} label="ジョブを開く" />
      </div>
      {description.error === null ? (
        <p className="mt-2 text-small text-muted-foreground">
          {description.recordState === "predates_status"
            ? "この状態になってからの失敗の記録はありません。"
            : "失敗の記録はありません。"}
        </p>
      ) : (
        <ErrorText
          text={description.error.text}
          truncated={description.error.truncated}
        />
      )}
    </li>
  );
}

/**
 * 失敗した監査の一覧。再実行できないので、操作は置かず、題名、時刻、失敗の内容、ジョブへのリンクだけを出す。
 * 失敗の内容は実行の出力で、プレーンテキストで描く。
 */
export function AuditFailureList({
  failures,
  now,
  initialPage,
}: {
  failures: readonly SummaryFailure[];
  now: number;
  /** 最初に出すページ(0から数える)。省略すると先頭。 */
  initialPage?: number | undefined;
}) {
  const pager = usePagination(failures.length, PAGE_SIZE, initialPage);
  if (failures.length === 0) {
    return <EmptyNote>失敗した監査はありません</EmptyNote>;
  }
  return (
    <div ref={pager.anchorRef} className="flex flex-col gap-3">
      <ul className="flex flex-col gap-3">
        {pageSlice(failures, pager.page, PAGE_SIZE).map((failure) => (
          <AuditFailureItem
            key={failure.work_item_id}
            failure={failure}
            now={now}
          />
        ))}
      </ul>
      <Pagination
        page={pager.page}
        total={failures.length}
        size={PAGE_SIZE}
        onPageChange={pager.change}
        label="監査の失敗のページ送り"
      />
    </div>
  );
}

function OrphanFailureItem({
  failure,
  now,
}: {
  failure: SystemOrphanFailure;
  now: number;
}) {
  const row = describeOrphanFailure(failure);
  return (
    <li className="rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-small break-words">
          {row.flowLabel}
        </span>
        <span className="text-small text-subtle">
          <TimeText iso={row.occurredAt} now={now} prefix="失敗 " />
        </span>
        <JobLink jobId={row.jobId} label="ジョブを開く" />
      </div>
      <ErrorText text={row.error.text} truncated={row.error.truncated} />
    </li>
  );
}

/**
 * 作業項目に紐づかない失敗の一覧。定期のジョブの失敗で、要対応の一覧には出ない。
 * 新しい順に並べて返ってくる。操作は置かない。
 */
export function OrphanFailureList({
  failures,
  now,
  initialPage,
}: {
  failures: readonly SystemOrphanFailure[];
  now: number;
  /** 最初に出すページ(0から数える)。省略すると先頭。 */
  initialPage?: number | undefined;
}) {
  const pager = usePagination(failures.length, PAGE_SIZE, initialPage);
  if (failures.length === 0) {
    return <EmptyNote>作業項目に紐づかない失敗はありません</EmptyNote>;
  }
  return (
    <div ref={pager.anchorRef} className="flex flex-col gap-3">
      <ul className="flex flex-col gap-3">
        {pageSlice(failures, pager.page, PAGE_SIZE).map((failure) => (
          <OrphanFailureItem
            key={failure.job_failure_id}
            failure={failure}
            now={now}
          />
        ))}
      </ul>
      <Pagination
        page={pager.page}
        total={failures.length}
        size={PAGE_SIZE}
        onPageChange={pager.change}
        label="作業項目に紐づかない失敗のページ送り"
      />
    </div>
  );
}
