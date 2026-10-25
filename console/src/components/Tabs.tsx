import { TriangleAlert } from "lucide-react";
import { type KeyboardEvent, useRef } from "react";
import { cn } from "../lib/cn.ts";
import { tabDomId, tabKeyTarget } from "../lib/tabs.ts";

/** タブ1つ分の指定。 */
export type TabSpec<Id extends string> = {
  readonly id: Id;
  readonly label: string;
  /** タブが指す本体の`id`。複数のタブが同じ本体を指してもよい。 */
  readonly panelId: string;
  /** 名前に添える件数。 */
  readonly count?: number | undefined;
  /** 名前に添える印の文言。色だけに頼らず、文字と記号で伝える。 */
  readonly mark?: string | undefined;
};

/**
 * タブの並び。矢印キーとHome、Endで移り、移った先を選ぶ。
 * 選んでいるタブだけがTabキーの停止位置になる。
 * 各タブの`aria-controls`は`panelId`を指す。本体の`aria-labelledby`には、`tabDomId(idPrefix, id)`を渡す。
 */
export function Tabs<Id extends string>({
  tabs,
  selected,
  onSelect,
  label,
  idPrefix,
}: {
  tabs: readonly TabSpec<Id>[];
  selected: Id;
  onSelect: (id: Id) => void;
  /** タブの並び全体の名前。 */
  label: string;
  /** タブの`id`の接頭辞。画面の中で重ならない値にする。 */
  idPrefix: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    const next = tabKeyTarget(event, index, tabs.length);
    const target = next === null ? undefined : tabs[next];
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
      aria-label={label}
      className="flex gap-1 overflow-x-auto border-b border-border px-4 md:px-8"
    >
      {tabs.map((tab, index) => {
        const isSelected = tab.id === selected;
        return (
          <button
            key={tab.id}
            ref={(element) => {
              refs.current[index] = element;
            }}
            id={tabDomId(idPrefix, tab.id)}
            type="button"
            role="tab"
            aria-selected={isSelected}
            aria-controls={tab.panelId}
            tabIndex={isSelected ? 0 : -1}
            onClick={() => {
              onSelect(tab.id);
            }}
            onKeyDown={(event) => {
              onKeyDown(event, index);
            }}
            className={cn(
              "-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 whitespace-nowrap py-2 text-body outline-none focus-visible:ring-2 focus-visible:ring-ring",
              isSelected
                ? "border-primary font-semibold text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
            {tab.count === undefined ? null : (
              <span className="rounded-md bg-foreground/10 px-1.5 text-caption font-medium tabular-nums">
                {tab.count}
              </span>
            )}
            {tab.mark === undefined ? null : (
              <span className="inline-flex items-center gap-1 text-caption font-normal text-failure">
                <TriangleAlert aria-hidden="true" className="size-3.5" />
                {tab.mark}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
