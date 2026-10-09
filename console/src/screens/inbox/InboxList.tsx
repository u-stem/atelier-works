import { type KeyboardEvent, useRef } from "react";
import { TimeText } from "../../components/TimeText.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { cn } from "../../lib/cn.ts";
import type { InboxSelection } from "../../lib/inboxSelection.ts";
import {
  describeRow,
  type InboxItem,
  selectionOf,
} from "../../lib/inboxView.ts";
import { nextNavFocusIndex } from "../../lib/navigation.ts";

/**
 * 要対応の一覧のペイン。行を選ぶと`onSelect`を呼ぶだけで、承認や再実行などの操作は起こさない。
 * 行の内容は`describeRow`が種類ごとに決めるので、この部品は種類を知らずに描く。
 * 上下の矢印とHome・Endで行の間を移れる。
 */
export function InboxList({
  items,
  selected,
  now,
  onSelect,
}: {
  items: readonly InboxItem[];
  selected: InboxSelection | null;
  now: number;
  onSelect: (selection: InboxSelection) => void;
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
      aria-label="要対応の一覧"
      className="flex flex-col"
      onKeyDown={handleKeyDown}
    >
      {items.map((item) => {
        const row = describeRow(item);
        const isSelected =
          selected !== null &&
          selected.type === item.type &&
          selected.id === item.id;
        return (
          <li key={row.key} className="border-b border-border">
            <button
              type="button"
              aria-current={isSelected ? "true" : undefined}
              className={cn(
                "flex w-full flex-col gap-1 px-4 py-3 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                isSelected && "bg-accent",
              )}
              onClick={() => {
                onSelect(selectionOf(item));
              }}
            >
              <span className="line-clamp-2 text-sm font-medium">
                {row.title}
              </span>
              <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline">{row.kindLabel}</Badge>
                {row.statusLabel === null ? null : (
                  <Badge variant="warning">{row.statusLabel}</Badge>
                )}
                {row.subLabel === null ? null : <span>{row.subLabel}</span>}
                <TimeText iso={row.iso} now={now} />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
