import { Link } from "react-router";
import type { SummaryFailure } from "../../api/guards/summary.ts";
import type { SystemOrphanFailure } from "../../api/guards/systemStatus.ts";
import { Disclosure } from "../../components/Disclosure.tsx";
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
import {
  groupOrphanFailures,
  type OrphanFailureDescription,
  type OrphanFailureGroup,
} from "../../lib/systemView.ts";
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
        {failure.superseded === true ? (
          <Badge variant="success">後の監査で報告済み</Badge>
        ) : null}
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
 * 後の監査で報告済みの失敗は一覧に残し、「後の監査で報告済み」の印を付ける。
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
  row,
  now,
}: {
  row: OrphanFailureDescription;
  now: number;
}) {
  return (
    <li className="rounded-lg border border-border bg-background p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {row.stepLabel === null ? null : (
          <span className="font-mono text-small break-words">
            {row.stepLabel}
          </span>
        )}
        <span className="text-small text-subtle">
          <TimeText iso={row.occurredAt} now={now} prefix="失敗 " />
        </span>
        <JobLink jobId={row.jobId} label="ジョブを開く" />
      </div>
      <ErrorText text={row.error.text} truncated={row.error.truncated} />
    </li>
  );
}

function OrphanFailureGroupItem({
  group,
  now,
  initialPage,
  jumpOpen,
}: {
  group: OrphanFailureGroup;
  now: number;
  initialPage: number | undefined;
  /** 節へ移るときに開く。 */
  jumpOpen: boolean;
}) {
  const pager = usePagination(group.failures.length, PAGE_SIZE, initialPage);
  return (
    <li className="rounded-xl border border-border bg-card px-5 py-3">
      <Disclosure
        jumpOpen={jumpOpen}
        summary={
          <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-mono text-small break-words">
              {group.flow}
            </span>
            <Badge variant="muted">{`${String(group.count)}回`}</Badge>
            <span className="text-small text-subtle">
              <TimeText iso={group.latestAt} now={now} prefix="最新 " />
            </span>
          </span>
        }
      >
        <div ref={pager.anchorRef} className="flex flex-col gap-3">
          <ul className="flex flex-col gap-3">
            {pageSlice(group.failures, pager.page, PAGE_SIZE).map((row) => (
              <OrphanFailureItem key={row.id} row={row} now={now} />
            ))}
          </ul>
          <Pagination
            page={pager.page}
            total={group.failures.length}
            size={PAGE_SIZE}
            onPageChange={pager.change}
            label={`${group.flow}の失敗のページ送り`}
          />
        </div>
      </Disclosure>
    </li>
  );
}

/**
 * 作業項目に紐づかない失敗を、flowごとにまとめて出す。定期のジョブの失敗で、要対応の一覧には出ない。
 * 組ごとに回数と最新の時刻を出し、開くと失敗を1件ずつ(ステップ、時刻、ジョブ、本文)見られる。
 * 組は最新の失敗が新しい順で、開いた中は10件ずつのページに分ける。操作は置かない。
 * 節へ移るときは、最新の失敗の組を開く。失敗の本文を、移った先で読めるようにするためである。
 */
export function OrphanFailureGroups({
  failures,
  now,
  initialPage,
}: {
  failures: readonly SystemOrphanFailure[];
  now: number;
  /** 最初に出すページ(0から数える)。省略すると先頭。組の全部に効く。 */
  initialPage?: number | undefined;
}) {
  if (failures.length === 0) {
    return <EmptyNote>作業項目に紐づかない失敗はありません</EmptyNote>;
  }
  const groups = groupOrphanFailures(failures);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-small text-muted-foreground">
        {`${String(failures.length)}件、${String(groups.length)}つのflow`}
      </p>
      <ul className="flex flex-col gap-3">
        {groups.map((group, index) => (
          <OrphanFailureGroupItem
            key={group.flow}
            group={group}
            now={now}
            initialPage={initialPage}
            jumpOpen={index === 0}
          />
        ))}
      </ul>
    </div>
  );
}
