// 要対応の画面で、幅が狭いときに一覧と詳細のどちらを出すかを決める。
// 広い画面(lg以上)では、どちらの面でも一覧と詳細を並べて出す。

import { cn } from "./cn.ts";
import type { InboxSelection } from "./inboxSelection.ts";

export type InboxPane = "list" | "detail";

/** 狭い画面で出す面。項目を選んでいれば詳細、選んでいなければ一覧にする。 */
export function inboxPane(selection: InboxSelection | null): InboxPane {
  return selection === null ? "list" : "detail";
}

/** 一覧のペインのクラス。狭い画面では幅いっぱいに広げ、詳細の面のあいだは隠す。 */
export function inboxListClass(pane: InboxPane): string {
  return cn(
    "w-full shrink-0 overflow-y-auto border-border bg-card lg:w-80 lg:border-r min-[1280px]:w-[28rem]",
    pane === "detail" && "hidden lg:block",
  );
}

/** 詳細のペインのクラス。狭い画面では一覧の面のあいだは隠す。 */
export function inboxDetailClass(pane: InboxPane): string {
  return cn(
    "min-w-0 flex-1 overflow-y-auto",
    pane === "list" && "hidden lg:block",
  );
}
