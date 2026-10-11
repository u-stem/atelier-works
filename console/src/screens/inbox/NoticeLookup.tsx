import { MousePointerClick } from "lucide-react";
import { ApiFailure, describeApiError } from "../../api/errors.ts";
import { useNotices } from "../../api/noticeQueries.ts";
import { Button } from "../../components/ui/button.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { NoticeDetail } from "./NoticeDetail.tsx";

function Message({ children }: { children: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <span className="inline-flex size-12 items-center justify-center rounded-full bg-muted text-subtle">
        <MousePointerClick aria-hidden="true" className="size-6" />
      </span>
      <p className="max-w-xs text-small text-muted-foreground">{children}</p>
    </div>
  );
}

/**
 * 選んだ通知が要対応の一覧に無いときの詳細。未解決の通知の一覧から探して出す。
 * 重要度が情報の通知と、要対応の一覧の上限を超えた通知は、一覧に載らないがURLで選べる。
 * 一覧にも無ければ、解決されたか取得前として`missing`の文を出す。
 */
export function NoticeLookup({
  noticeId,
  now,
  missing,
}: {
  noticeId: number;
  now: number;
  missing: string;
}) {
  const notices = useNotices();
  // 取得中は、前に読んだ一覧を使わない。解決した通知を、未解決のまま出さないためである。
  if (notices.isFetching) {
    return (
      <div className="space-y-4 p-8" role="status">
        <span className="sr-only">読み込み中</span>
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-40 w-full max-w-3xl rounded-xl" />
      </div>
    );
  }
  if (notices.isError || notices.data === undefined) {
    const apiError =
      notices.error instanceof ApiFailure ? notices.error.apiError : null;
    return (
      <div className="flex flex-col items-start gap-3 p-8">
        <p className="text-small text-muted-foreground">
          {apiError === null
            ? "通知を取得できませんでした。"
            : describeApiError(apiError)}
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void notices.refetch();
          }}
        >
          もう一度取得する
        </Button>
      </div>
    );
  }
  const notice = notices.data.find((row) => row.notice_id === noticeId);
  return notice === undefined ? (
    <Message>{missing}</Message>
  ) : (
    <NoticeDetail notice={notice} now={now} source="full" />
  );
}
