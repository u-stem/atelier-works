import { type KeyboardEvent, useRef } from "react";
import { cn } from "../../../lib/cn.ts";
import {
  hasModifierKey,
  ITEM_DETAIL_TABS,
  type ItemDetailTabId,
  nextTabIndex,
} from "../../../lib/itemDetailView.ts";

/** タブの本体の`id`。選んでいるタブの`aria-controls`が指す。 */
export const ITEM_DETAIL_PANEL_ID = "item-detail-panel";

function tabId(id: ItemDetailTabId): string {
  return `item-detail-tab-${id}`;
}

/** 選んでいるタブの本体に付ける、タブを指す名前。 */
export function panelLabelledBy(selected: ItemDetailTabId): string {
  return tabId(selected);
}

/**
 * 作業項目の詳細のタブ。矢印キーとHome、Endで移り、移った先を選ぶ。
 * 選んでいるタブだけがTabキーの停止位置になる。
 */
export function ItemDetailTabs({
  selected,
  onSelect,
}: {
  selected: ItemDetailTabId;
  onSelect: (id: ItemDetailTabId) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    // Alt+矢印などはブラウザの操作なので、タブの移動で奪わない。
    if (hasModifierKey(event)) {
      return;
    }
    const next = nextTabIndex(index, event.key, ITEM_DETAIL_TABS.length);
    const target = next === null ? undefined : ITEM_DETAIL_TABS[next];
    if (next === null || target === undefined) {
      return;
    }
    event.preventDefault();
    onSelect(target.id);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="作業項目の詳細"
      className="flex gap-1 border-b border-border px-8"
    >
      {ITEM_DETAIL_TABS.map((tab, index) => {
        const isSelected = tab.id === selected;
        return (
          <button
            key={tab.id}
            ref={(element) => {
              refs.current[index] = element;
            }}
            id={tabId(tab.id)}
            type="button"
            role="tab"
            aria-selected={isSelected}
            aria-controls={ITEM_DETAIL_PANEL_ID}
            tabIndex={isSelected ? 0 : -1}
            onClick={() => {
              onSelect(tab.id);
            }}
            onKeyDown={(event) => {
              onKeyDown(event, index);
            }}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-body outline-none focus-visible:ring-2 focus-visible:ring-ring",
              isSelected
                ? "border-primary font-semibold text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
