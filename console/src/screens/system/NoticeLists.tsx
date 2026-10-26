import { Link } from "react-router";
import type { NoticeRow } from "../../api/guards/notices.ts";
import type { SystemResolvedNotice } from "../../api/guards/systemStatus.ts";
import { Pagination } from "../../components/Pagination.tsx";
import { TimeText } from "../../components/TimeText.tsx";
import { FAILURE_TEXT_LIMIT } from "../../lib/failureView.ts";
import { pageSlice } from "../../lib/pagination.ts";
import {
  describeInfoNotice,
  describeResolvedNotice,
} from "../../lib/systemView.ts";
import { usePagination } from "../../lib/usePagination.ts";
import { EmptyNote } from "./SystemSection.tsx";

/** 1ページに出す通知の数。 */
const PAGE_SIZE = 10;

const LINK_CLASS =
  "shrink-0 rounded-sm text-small font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * 情報の通知の一覧。人の行動が要らないので、要対応の一覧には出ない通知である。
 * 行の「詳細」から、要対応の画面の同じ詳細を開く。解決はそこで行い、この画面では行わない。
 * 本文はIssueや実行の出力に由来しうるので、プレーンテキストで描く。
 */
export function InfoNoticeList({
  notices,
  now,
  initialPage,
}: {
  notices: readonly NoticeRow[];
  now: number;
  /** 最初に出すページ(0から数える)。省略すると先頭。 */
  initialPage?: number | undefined;
}) {
  const pager = usePagination(notices.length, PAGE_SIZE, initialPage);
  if (notices.length === 0) {
    return <EmptyNote>情報の通知はありません</EmptyNote>;
  }
  return (
    <div ref={pager.anchorRef} className="flex flex-col gap-3">
      <ul className="divide-y divide-border rounded-xl border border-border bg-card">
        {pageSlice(notices, pager.page, PAGE_SIZE).map((notice) => {
          const row = describeInfoNotice(notice);
          return (
            <li
              key={row.noticeId}
              className="flex items-baseline gap-3 px-5 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-x-3">
                  <span className="text-body font-medium">{row.title}</span>
                  <span className="text-small text-subtle">
                    <TimeText iso={row.createdAt} now={now} />
                  </span>
                </p>
                {row.preview === "" ? null : (
                  <p
                    dir="ltr"
                    className="mt-0.5 text-small break-words text-muted-foreground [unicode-bidi:isolate]"
                  >
                    {row.preview}
                  </p>
                )}
              </div>
              <Link to={row.href} className={LINK_CLASS}>
                詳細
                {row.canResolve ? "と解決" : ""}
              </Link>
            </li>
          );
        })}
      </ul>
      <Pagination
        page={pager.page}
        total={notices.length}
        size={PAGE_SIZE}
        onPageChange={pager.change}
        label="情報の通知のページ送り"
      />
    </div>
  );
}

function ResolvedItem({
  notice,
  now,
}: {
  notice: SystemResolvedNotice;
  now: number;
}) {
  const row = describeResolvedNotice(notice);
  return (
    <li className="px-5 py-3">
      <details className="group">
        <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-3 gap-y-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="text-body font-medium">{row.title}</span>
          <span className="text-small text-subtle">
            {row.resolvedAt === null ? (
              "解決の時刻の記録なし"
            ) : (
              <TimeText iso={row.resolvedAt} now={now} prefix="解決 " />
            )}
          </span>
          <span className="text-small text-subtle">{row.resolver}</span>
          <span className="w-full text-small break-words text-muted-foreground group-open:hidden">
            {row.preview}
          </span>
        </summary>
        <div className="mt-2 flex flex-col gap-1">
          <p
            dir="ltr"
            className="text-small break-words whitespace-pre-wrap text-foreground [unicode-bidi:isolate]"
          >
            {row.message}
          </p>
          {row.truncated ? (
            <p className="text-small text-warning">
              先頭の{FAILURE_TEXT_LIMIT}字だけを表示しています。
            </p>
          ) : null}
          <p className="text-small text-subtle">
            <TimeText iso={row.createdAt} now={now} prefix="発生 " />
          </p>
        </div>
      </details>
    </li>
  );
}

/**
 * 解決済みの通知の履歴を、件数を添えてたたむ。
 * 履歴は参照用で、普段は読まないので、開くまで本文の一覧を見せない。
 */
export function ResolvedNoticeDisclosure(_props: {
  notices: readonly SystemResolvedNotice[];
  now: number;
  initiallyOpen?: boolean | undefined;
}) {
  return null;
}

/**
 * 解決済みの通知の履歴。人が解決したものを先に、DBの掃除が解決したものを後に、それぞれ解決の新しい順で並べて返ってくる。
 * 行を開くと本文の全文を読める。履歴なので、再び開く操作は無い。
 */
export function ResolvedNoticeList({
  notices,
  now,
  initialPage,
}: {
  notices: readonly SystemResolvedNotice[];
  now: number;
  /** 最初に出すページ(0から数える)。省略すると先頭。 */
  initialPage?: number | undefined;
}) {
  const pager = usePagination(notices.length, PAGE_SIZE, initialPage);
  if (notices.length === 0) {
    return <EmptyNote>解決済みの通知はありません</EmptyNote>;
  }
  return (
    <div ref={pager.anchorRef} className="flex flex-col gap-3">
      <ul className="divide-y divide-border rounded-xl border border-border bg-card">
        {pageSlice(notices, pager.page, PAGE_SIZE).map((notice) => (
          <ResolvedItem key={notice.notice_id} notice={notice} now={now} />
        ))}
      </ul>
      <Pagination
        page={pager.page}
        total={notices.length}
        size={PAGE_SIZE}
        onPageChange={pager.change}
        label="解決済みの通知のページ送り"
      />
    </div>
  );
}
