import type { InboxSelection } from "../../lib/inboxSelection.ts";
import type { InboxItem } from "../../lib/inboxView.ts";
import { ApprovalOverview } from "./ApprovalOverview.tsx";

function Message({ children }: { children: string }) {
  return <p className="p-6 text-sm text-muted-foreground">{children}</p>;
}

/**
 * 要対応の詳細のペイン。選んだ項目の種類ごとに、描く部品を1か所で振り分ける。
 * 承認は概要を描く。失敗と通知は、詳細を描く部品ができるまで、概要を出さない旨の文だけを出す。
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
    return (
      <Message>
        {selection === null
          ? "一覧から項目を選んでください。"
          : "選んだ項目は一覧にありません。すでに処理されたか、まだ取得できていません。"}
      </Message>
    );
  }
  switch (item.type) {
    case "approval":
      return <ApprovalOverview approval={item.approval} now={now} />;
    case "failure":
      return <Message>失敗の詳細は、この画面に追加されます。</Message>;
    case "notice":
      return <Message>通知の詳細は、この画面に追加されます。</Message>;
  }
}
