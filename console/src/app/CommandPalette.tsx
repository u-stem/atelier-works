import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router";
import { focusElement, useDialogSync } from "../components/useDialogSync.ts";
import { cn } from "../lib/cn.ts";
import {
  chooseItem,
  filterPaletteItems,
  type PaletteItem,
  paletteItems,
  paletteKeyAction,
  paletteSections,
  paletteStatus,
} from "../lib/commandPalette.ts";
import { TRANSITION_COLORS } from "../lib/motionClasses.ts";
import { isOutsideRect } from "../lib/navDrawer.ts";
import { SCREENS } from "./screens.ts";

const KBD_CLASS =
  "rounded border border-border bg-muted px-1.5 font-sans text-caption leading-5 text-muted-foreground";

/**
 * コマンドパレット。ブラウザ標準の`<dialog>`をモーダルで開く。
 * 検索の対象は、画面の表にある画面と、ショートカットの一覧(ヘルプ)だけで、表示する文字はすべて固定の表から作る。
 * 入力欄にフォーカスを残し、選んでいる項目は`aria-activedescendant`で示す。項目にはフォーカスを移さない。
 * 項目を選ぶと、先にパレットを閉じてから移る。閉じるとブラウザが元の要素へフォーカスを戻すので、
 * 遷移後のフォーカスの移動を奪わない。Escで閉じたときは、元の要素に戻る。
 * `data-command-palette`は、キーボードの規則が、開いているダイアログのうちパレット自身を見分ける目印である。
 */
export function CommandPalette({
  open,
  onClose,
  onOpenHelp,
}: {
  open: boolean;
  /** 閉じたときに呼ぶ。項目を選んだ後も、Escや背景の押下の後も呼ぶ。 */
  onClose: () => void;
  onOpenHelp: () => void;
}) {
  const navigate = useNavigate();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const reset = useCallback(() => {
    setQuery("");
    setActive(0);
    focusElement(inputRef.current);
  }, []);
  const { ref, openRef } = useDialogSync(open, reset);

  const items = useMemo(() => paletteItems(SCREENS), []);
  const shown = filterPaletteItems(items, query);
  const sections = paletteSections(shown);
  const activeIndex =
    shown.length === 0 ? -1 : Math.min(active, shown.length - 1);
  const optionId = (item: PaletteItem): string => `${listId}-${item.id}`;
  const activeItem = shown[activeIndex];
  const activeId = activeItem === undefined ? undefined : optionId(activeItem);

  // キーで選んだ項目が、一覧の枠の外に出ないようにする。
  useEffect(() => {
    if (activeId !== undefined) {
      document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
    }
  }, [activeId]);

  const choose = (item: PaletteItem): void => {
    chooseItem(item, {
      close: () => {
        ref.current?.close();
      },
      navigate: (path) => {
        void navigate(path);
      },
      openHelp: onOpenHelp,
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const action = paletteKeyAction(
      event.nativeEvent,
      activeIndex,
      shown.length,
    );
    if (action.kind === "move") {
      event.preventDefault();
      setActive(action.index);
    } else if (action.kind === "choose") {
      event.preventDefault();
      const item = shown[action.index];
      if (item !== undefined) {
        choose(item);
      }
    }
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: 背景の押下で閉じる操作は補助である。キーボードではEscで同じことができる。
    <dialog
      ref={ref}
      data-command-palette=""
      aria-label="コマンドパレット"
      onClose={() => {
        // 親が`open`を偽にして閉じたときは、親がすでに知っているので知らせない。
        if (openRef.current) {
          onClose();
        }
      }}
      onClick={(event) => {
        // 背景(::backdrop)の押下は、dialog自身が対象になり、座標がdialogの外になる。
        if (event.target !== event.currentTarget) {
          return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        if (isOutsideRect({ x: event.clientX, y: event.clientY }, rect)) {
          ref.current?.close();
        }
      }}
      className="mx-auto mt-[12vh] mb-auto w-[min(36rem,calc(100vw-1rem))] overflow-hidden rounded-xl border border-border bg-popover p-0 text-popover-foreground shadow-raised backdrop:bg-black/50"
    >
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={true}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        aria-label="画面やヘルプを探す"
        placeholder="画面やヘルプを探す"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={handleKeyDown}
        className="h-12 w-full border-b border-border bg-transparent px-4 text-body outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      />
      <div role="status" className="sr-only">
        {paletteStatus(shown.length)}
      </div>
      <div
        id={listId}
        role="listbox"
        aria-label="候補"
        className="max-h-[min(24rem,60dvh)] overflow-y-auto p-2"
      >
        {sections.map((section) => {
          const headingId = `${listId}-group-${section.id}`;
          return (
            // biome-ignore lint/a11y/useSemanticElements: listboxの中の項目の組で、fieldsetは使えない。
            <div key={section.id} role="group" aria-labelledby={headingId}>
              <div
                id={headingId}
                data-group-heading=""
                className="px-2 py-1 text-caption font-medium text-subtle"
              >
                {section.label}
              </div>
              {section.items.map((item) => {
                const selected = item === activeItem;
                return (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: キーボードの操作は、入力欄のEnterと矢印で行う。
                  // biome-ignore lint/a11y/useFocusableInteractive: フォーカスは入力欄に残し、選択は`aria-activedescendant`で示す。
                  <div
                    key={item.id}
                    id={optionId(item)}
                    role="option"
                    aria-selected={selected}
                    onPointerMove={() => {
                      setActive(shown.indexOf(item));
                    }}
                    onMouseDown={(event) => {
                      // 押してもフォーカスが入力欄から外れないようにする。
                      event.preventDefault();
                    }}
                    onClick={() => {
                      choose(item);
                    }}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-body",
                      TRANSITION_COLORS,
                      selected && "bg-selected text-selected-foreground",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {item.label}
                    </span>
                    <span aria-hidden="true" className="flex shrink-0 gap-1">
                      {item.hint.map((key) => (
                        <kbd key={key} className={KBD_CLASS}>
                          {key}
                        </kbd>
                      ))}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {shown.length === 0 ? (
        <p
          aria-hidden="true"
          className="px-4 py-6 text-center text-small text-muted-foreground"
        >
          該当する項目はありません
        </p>
      ) : null}
    </dialog>
  );
}
