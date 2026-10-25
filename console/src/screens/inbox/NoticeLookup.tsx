import { MousePointerClick } from "lucide-react";
import { useNotices } from "../../api/noticeQueries.ts";
import { loadPhaseOf } from "../../api/sectionQuery.ts";
import {
  LoadingBody,
  type LoadingShape,
  useLoadingDisplay,
} from "../../components/LoadingState.tsx";
import { QueryFailureAlert } from "../../components/QueryFailureAlert.tsx";
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

/** 読み込み中の形。 */
const LOADING_SHAPE: LoadingShape = {
  className: "space-y-4 p-8",
  node: (
    <>
      <Skeleton className="h-5 w-20" />
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-40 w-full max-w-3xl rounded-xl" />
    </>
  ),
};

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
  // 取得の最初の間は空の枠を出し、前に読んだ一覧も隠す。
  const display = useLoadingDisplay(
    notices.isFetching ? "loading" : loadPhaseOf(notices),
  );
  if (display !== "content") {
    return <LoadingBody display={display} shape={LOADING_SHAPE} />;
  }
  if (notices.isError || notices.data === undefined) {
    return (
      <div className="p-8">
        <QueryFailureAlert
          title="通知を取得できませんでした"
          error={notices.error}
          onRetry={() => {
            void notices.refetch();
          }}
        />
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
