import { cn } from "../lib/cn.ts";
import type { InboxKind } from "../lib/inboxSelection.ts";

const DOT_CLASS: Readonly<Record<InboxKind, string>> = {
  approval: "bg-approval",
  failure: "bg-failure",
  notice: "bg-notice-mark",
};

/** 種類を色で示す点(承認は青、失敗は赤、通知は琥珀)。意味は隣の文字が伝えるので、読み上げからは外す。 */
export function KindDot({
  type,
  className,
}: {
  type: InboxKind;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        DOT_CLASS[type],
        className,
      )}
    />
  );
}
