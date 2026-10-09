import { type KeyboardEvent, useRef } from "react";
import { KindDot } from "../../components/KindDot.tsx";
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
 * 行は1つのbuttonなので、行の中に再実行や承認などの操作は入れない(buttonを入れ子にしないため)。
 * 操作は詳細のペインに置く。
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
    // biomeはindexOfを勧めるが、activeElementはElement | nullで、indexOfの引数の型に合わない。
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
      className="flex flex-col divide-y divide-border"
      onKeyDown={handleKeyDown}
    >
      {items.map((item) => {
        const row = describeRow(item, now);
        const itemSelection = selectionOf(item);
        const isSelected =
          selected !== null &&
          selected.type === itemSelection.type &&
          selected.id === itemSelection.id;
        return (
          <li key={row.key}>
            <button
              type="button"
              aria-current={isSelected ? "true" : undefined}
              className={cn(
                "relative grid w-full grid-cols-[auto_1fr] gap-x-3 px-6 py-4 text-left outline-none transition-colors duration-150 motion-reduce:transition-none",
                "hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                "before:absolute before:inset-y-3 before:left-0 before:w-[3px] before:rounded-r-full before:bg-primary before:opacity-0 before:transition-opacity before:duration-150",
                "aria-[current=true]:bg-selected aria-[current=true]:before:opacity-100",
              )}
              onClick={() => {
                onSelect(itemSelection);
              }}
            >
              <KindDot type={item.type} className="mt-2" />
              <span className="min-w-0">
                <span className="line-clamp-2 block text-body leading-snug font-medium text-foreground">
                  {row.title}
                </span>
                <span className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-small text-subtle">
                  <span className="font-medium text-muted-foreground">
                    {row.kindLabel}
                  </span>
                  {row.statusLabel === null ? null : (
                    <Badge variant="warning">{row.statusLabel}</Badge>
                  )}
                  {row.subLabel === null ? null : <span>{row.subLabel}</span>}
                  {row.expiry === null ? null : (
                    <span
                      className={cn(
                        "tabular-nums",
                        row.expiry.expired && "font-medium text-failure",
                      )}
                    >
                      {row.expiry.label}
                    </span>
                  )}
                  <TimeText iso={row.iso} now={now} />
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
