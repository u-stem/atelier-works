import { type KeyboardEvent, useRef } from "react";
import { TimeText } from "../../components/TimeText.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { cn } from "../../lib/cn.ts";
import type { InboxSelection } from "../../lib/inboxSelection.ts";
import {
  describeRow,
  type InboxItem,
  omitsKindLabels,
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
  allItems,
  onSelect,
}: {
  /** 描く行。種類の切り替えで絞り込んだ後の項目である。 */
  items: readonly InboxItem[];
  selected: InboxSelection | null;
  now: number;
  /**
   * 絞り込む前の一覧全体。
   * 種別の語を省くかと、副題で見分ける相手を、この全体で決める。
   * 切り替えで行の書式が変わらないようにするためである。
   */
  allItems: readonly InboxItem[];
  onSelect: (selection: InboxSelection) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const showKind = !omitsKindLabels(allItems);

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
        const row = describeRow(item, now, { showKind, peers: allItems });
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
                "relative block w-full px-6 py-3.5 text-left outline-none transition-colors duration-150 motion-reduce:transition-none",
                "hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                "before:absolute before:inset-y-3 before:left-0 before:w-[3px] before:rounded-r-full before:bg-primary before:opacity-0 before:transition-opacity before:duration-150",
                "aria-[current=true]:bg-selected aria-[current=true]:before:opacity-100",
              )}
              onClick={() => {
                onSelect(itemSelection);
              }}
            >
              <span className="flex items-baseline justify-between gap-3">
                <span className="truncate text-body font-medium text-foreground">
                  {row.title}
                </span>
                <span className="shrink-0 text-small text-subtle tabular-nums">
                  <TimeText iso={row.iso} now={now} />
                </span>
              </span>
              <span className="mt-1 flex h-6 items-center gap-2.5 overflow-hidden text-small whitespace-nowrap text-subtle">
                {row.kindLabel === null ? null : (
                  <span className="shrink-0 font-medium text-muted-foreground">
                    {row.kindLabel}
                  </span>
                )}
                {row.subLabel === null ? null : (
                  <span
                    className="min-w-0 truncate"
                    title={row.subTitle ?? undefined}
                  >
                    {row.subLabel}
                  </span>
                )}
                {row.expiry === null ? null : (
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1.5 tabular-nums",
                      row.expiry.urgent && "font-medium text-warning",
                      row.expiry.expired && "text-failure",
                    )}
                  >
                    {row.expiry.urgent ? (
                      <span
                        aria-hidden="true"
                        className={cn(
                          "size-1.5 rounded-full",
                          row.expiry.expired ? "bg-failure" : "bg-notice-mark",
                        )}
                      />
                    ) : null}
                    {row.expiry.label}
                  </span>
                )}
                {row.statusLabel === null ? null : (
                  <Badge variant="warning" className="ml-auto min-w-0 shrink">
                    <span className="truncate">{row.statusLabel}</span>
                  </Badge>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
