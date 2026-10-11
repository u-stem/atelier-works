import { type ReactNode, useEffect, useRef } from "react";

/** 横並びのメニューへ切り替わる幅(Tailwindのmd)。ドロワーはこの幅以上では閉じる。 */
const WIDE_QUERY = "(min-width: 48rem)";

/**
 * 幅が狭い画面でメニューを出すドロワー。ブラウザ標準の`<dialog>`をモーダルで開き、左から出す。
 * Escと背景の押下で閉じ、背面の操作を止め、フォーカスを中に留める。
 * 閉じる操作はすべて`onClose`を呼ぶ。`open`を偽にして閉じたときは呼ばない。
 * 画面が広がって横並びのメニューに切り替わったら、背面を操作できるよう自分で閉じる。
 */
export function NavDrawer({
  open,
  label,
  onClose,
  children,
}: {
  open: boolean;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const openRef = useRef(open);

  useEffect(() => {
    openRef.current = open;
    const dialog = ref.current;
    if (dialog === null) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const query = window.matchMedia(WIDE_QUERY);
    const closeWhenWide = (): void => {
      if (query.matches) {
        onClose();
      }
    };
    query.addEventListener("change", closeWhenWide);
    return () => {
      query.removeEventListener("change", closeWhenWide);
    };
  }, [open, onClose]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: 背景の押下で閉じる操作は補助である。キーボードではEscと閉じるボタンで同じことができる。
    <dialog
      ref={ref}
      aria-label={label}
      onClose={() => {
        // 親からの閉じ込みでは、すでに開いていない。閉じる副作用を二重に走らせない。
        if (openRef.current) {
          onClose();
        }
      }}
      onClick={(event) => {
        // 背景(::backdrop)の押下は、dialog自身が対象になる。中身の押下は対象が子になる。
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      className="fixed inset-y-0 left-0 m-0 h-dvh max-h-none w-64 max-w-[85vw] flex-col border-r border-sidebar-border bg-sidebar p-0 text-sidebar-foreground backdrop:bg-black/50 open:flex"
    >
      {children}
    </dialog>
  );
}
