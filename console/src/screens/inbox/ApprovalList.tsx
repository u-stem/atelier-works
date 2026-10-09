import { type KeyboardEvent, useRef } from "react";
import type { SummaryApproval } from "../../api/guards/summary.ts";
import { TimeText } from "../../components/TimeText.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { cn } from "../../lib/cn.ts";
import { describeApproval } from "../../lib/inboxView.ts";
import { nextNavFocusIndex } from "../../lib/navigation.ts";

/**
 * 承認待ちの一覧。行を選ぶと`onSelect`を呼ぶだけで、承認や却下は起こさない。
 * 上下の矢印とHome・Endで行の間を移れる。
 */
export function ApprovalList({
  approvals,
  selectedId,
  now,
  onSelect,
}: {
  approvals: readonly SummaryApproval[];
  selectedId: number | null;
  now: number;
  onSelect: (id: number) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);

  const handleKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    const rows = Array.from(listRef.current?.querySelectorAll("button") ?? []);
    const current = rows.findIndex((row) => row === document.activeElement);
    const next = nextNavFocusIndex(event.key, current, rows.length);
    if (next === null) {
      return;
    }
    event.preventDefault();
    rows[next]?.focus();
  };

  return (
    <ul
      ref={listRef}
      aria-label="承認待ちの一覧"
      className="flex flex-col"
      onKeyDown={handleKeyDown}
    >
      {approvals.map((approval) => {
        const description = describeApproval(approval);
        const selected = approval.approval_request_id === selectedId;
        return (
          <li
            key={approval.approval_request_id}
            className="border-b border-border"
          >
            <button
              type="button"
              aria-current={selected ? "true" : undefined}
              className={cn(
                "flex w-full flex-col gap-1 px-4 py-3 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                selected && "bg-accent",
              )}
              onClick={() => {
                onSelect(approval.approval_request_id);
              }}
            >
              <span className="line-clamp-2 text-sm font-medium">
                {description.title}
              </span>
              <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline">{description.kindLabel}</Badge>
                <span>{description.workItemLabel}</span>
                <TimeText iso={approval.requested_at} now={now} />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
