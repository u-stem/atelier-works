import { MousePointerClick } from "lucide-react";
import type { InboxSelection } from "../../lib/inboxSelection.ts";
import {
  type InboxItem,
  missingSelectionMessage,
} from "../../lib/inboxView.ts";
import { ApprovalOverview } from "./ApprovalOverview.tsx";
import { NoticeDetail } from "./NoticeDetail.tsx";
import { NoticeLookup } from "./NoticeLookup.tsx";

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
 * 要対応の詳細のペイン。選んだ項目の種類ごとに、描く部品を1か所で振り分ける。
 * 承認は概要、通知は詳細と解決の操作を描く。失敗は、詳細を描く部品がないので、準備中である旨の文だけを出す。
 * 選んだ通知が一覧に無いときは、未解決の通知の一覧から探す。
 */
export function InboxDetail({
  item,
  selection,
  now,
}: {
  item: InboxItem | null;
  selection: InboxSelection | null;
  now: number;
}) {
  if (item === null) {
    if (selection?.type === "notice") {
      return (
        <NoticeLookup
          noticeId={selection.id}
          now={now}
          missing={missingSelectionMessage(selection)}
        />
      );
    }
    return <Message>{missingSelectionMessage(selection)}</Message>;
  }
  switch (item.type) {
    case "approval":
      return <ApprovalOverview approval={item.approval} now={now} />;
    case "failure":
      return <Message>失敗の詳細は準備中です。</Message>;
    case "notice":
      return <NoticeDetail notice={item.notice} now={now} />;
  }
}
