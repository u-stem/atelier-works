import { ChevronRight } from "lucide-react";
import { type KeyboardEvent, useId, useMemo, useRef, useState } from "react";
import { TimeText } from "../../components/TimeText.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { cn } from "../../lib/cn.ts";
import {
  describeGroup,
  expandedAfterSelection,
  groupInboxItems,
  groupKindOfSelection,
  type InboxRow,
} from "../../lib/inboxGroups.ts";
import { rowDomKey } from "../../lib/inboxPane.ts";
import type { InboxSelection } from "../../lib/inboxSelection.ts";
import {
  describeRow,
  type InboxItem,
  omitsKindLabels,
  type RowDescription,
  selectionOf,
} from "../../lib/inboxView.ts";
import { nextNavFocusIndex } from "../../lib/navigation.ts";

const ROW_BUTTON_CLASS = cn(
  "relative block w-full px-6 py-3.5 text-left outline-none transition-colors duration-150 motion-reduce:transition-none",
  "hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
  "before:absolute before:inset-y-3 before:left-0 before:w-[3px] before:rounded-r-full before:bg-primary before:opacity-0 before:transition-opacity before:duration-150",
  "aria-[current=true]:bg-selected aria-[current=true]:before:opacity-100",
);

/** 項目1件の行。選ぶだけで、操作は詳細のペインに置く。`nested`はグループの中の行で、字下げする。 */
function ItemRow({
  row,
  item,
  selected,
  now,
  nested,
  onSelect,
}: {
  row: RowDescription;
  item: InboxItem;
  selected: InboxSelection | null;
  now: number;
  nested: boolean;
  onSelect: (selection: InboxSelection) => void;
}) {
  const itemSelection = selectionOf(item);
  const isSelected =
    selected !== null &&
    selected.type === itemSelection.type &&
    selected.id === itemSelection.id;
  return (
    <button
      type="button"
      data-row={rowDomKey(itemSelection)}
      aria-current={isSelected ? "true" : undefined}
      className={cn(ROW_BUTTON_CLASS, nested && "pl-11")}
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
          <span className="min-w-0 truncate" title={row.subTitle ?? undefined}>
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
  );
}

/**
 * 要対応の一覧のペイン。行を選ぶと`onSelect`を呼ぶだけで、承認や再実行などの操作は起こさない。
 * 行の内容は`describeRow`が種類ごとに決めるので、この部品は種類を知らずに描く。
 * 行は1つのbuttonなので、行の中に再実行や承認などの操作は入れない(buttonを入れ子にしないため)。
 * 操作は詳細のペインに置く。
 * 同じ種別の未解決の通知が2件以上あるときは、件数つきの1行にまとめ、押すと個々の通知を開閉する。
 * 開閉の状態はこの部品が持つ。選んだ通知を含むグループは、選択が移ったときに開く。
 * 上下の矢印とHome・Endで行の間を移れる。開閉のbuttonも行の間に数える。
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
  const idBase = useId();
  const showKind = !omitsKindLabels(allItems);
  const rows = useMemo(() => groupInboxItems(items), [items]);
  const selectedKind = groupKindOfSelection(rows, selected);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() =>
    expandedAfterSelection(new Set<string>(), rows, selected),
  );
  // 選択が別のグループへ移ったときだけ開く。開いた後に自分で閉じた状態を、再描画のたびに戻さないためである。
  const openedKey = selectedKind === null ? null : `${selected?.id}`;
  const [openedFor, setOpenedFor] = useState<string | null>(openedKey);
  if (openedKey !== openedFor) {
    setOpenedFor(openedKey);
    setExpanded(expandedAfterSelection(expanded, rows, selected));
  }

  const toggle = (kind: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(kind)) {
        next.add(kind);
      }
      return next;
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    const buttons = Array.from(
      listRef.current?.querySelectorAll("button") ?? [],
    );
    // biomeはindexOfを勧めるが、activeElementはElement | nullで、indexOfの引数の型に合わない。
    const current = buttons.findIndex(
      (button) => button === document.activeElement,
    );
    const next = nextNavFocusIndex(event.key, current, buttons.length);
    if (next === null) {
      return;
    }
    event.preventDefault();
    buttons[next]?.focus();
  };

  const renderItem = (
    item: InboxItem,
    options: { showKind: boolean; nested: boolean },
  ) => {
    const row = describeRow(item, now, {
      showKind: options.showKind,
      peers: allItems,
    });
    return (
      <li key={row.key}>
        <ItemRow
          row={row}
          item={item}
          selected={selected}
          now={now}
          nested={options.nested}
          onSelect={onSelect}
        />
      </li>
    );
  };

  const renderGroup = (
    row: Extract<InboxRow, { type: "group" }>,
    index: number,
  ) => {
    const group = describeGroup(row);
    const open = expanded.has(row.kind);
    const listId = `${idBase}-group-${index}`;
    return (
      <li key={group.key}>
        <button
          type="button"
          data-group={group.key}
          data-contains-selection={
            !open && selectedKind === row.kind ? "true" : undefined
          }
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          className={cn(
            ROW_BUTTON_CLASS,
            "data-[contains-selection=true]:bg-selected",
          )}
          onClick={() => {
            toggle(row.kind);
          }}
        >
          <span className="flex items-baseline justify-between gap-3">
            <span className="flex min-w-0 items-center gap-1.5">
              <ChevronRight
                aria-hidden="true"
                className={cn(
                  "size-4 shrink-0 self-center text-subtle transition-transform duration-150 motion-reduce:transition-none",
                  open && "rotate-90",
                )}
              />
              <span className="truncate text-body font-medium text-foreground">
                {group.title}
              </span>
            </span>
            <span className="shrink-0 text-small text-subtle tabular-nums">
              <TimeText iso={group.iso} now={now} />
            </span>
          </span>
          <span className="mt-1 flex h-6 items-center gap-2.5 overflow-hidden pl-5.5 text-small whitespace-nowrap text-subtle">
            {showKind ? (
              <span className="shrink-0 font-medium text-muted-foreground">
                通知
              </span>
            ) : null}
            <Badge variant="warning">{group.countLabel}</Badge>
          </span>
        </button>
        {open ? (
          <ul id={listId} className="flex flex-col divide-y divide-border">
            {row.notices.map((item) =>
              renderItem(item, { showKind: false, nested: true }),
            )}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <ul
      ref={listRef}
      className="flex flex-col divide-y divide-border"
      onKeyDown={handleKeyDown}
    >
      {rows.map((row, index) =>
        row.type === "group"
          ? renderGroup(row, index)
          : renderItem(row.item, { showKind, nested: false }),
      )}
    </ul>
  );
}
