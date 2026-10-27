import { type ReactNode, useEffect } from "react";
import { useDialogSync } from "../components/useDialogSync.ts";
import { isOutsideRect } from "../lib/navDrawer.ts";
import { useMediaQuery } from "./useMediaQuery.ts";

/** 横並びのメニューへ切り替わる幅(Tailwindのmd)。ドロワーはこの幅以上では閉じる。 */
const WIDE_QUERY = "(min-width: 48rem)";

/**
 * 幅が狭い画面でメニューを出すドロワー。ブラウザ標準の`<dialog>`をモーダルで開き、左から出す。
 * Escと背景の押下で閉じ、背面の操作を止め、フォーカスを中に留める。
 * 閉じる操作はすべて`onClose`を呼ぶ。`open`を偽にして閉じたときは呼ばない。
 * 画面が広がって横並びのメニューに切り替わったら、背面を操作できるよう自分で閉じる。
 * 中身は`dialog`の高さいっぱいの枠で包む。中の空きを押しても、背景の押下と見分けられるようにするためである。
 * `data-nav-drawer`は、画面の遷移後にフォーカスを移す側が、このドロワーの閉じ終わりを待つ目印である。
 * `dialog.close()`は、開く前にフォーカスのあった要素へフォーカスを戻す。
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
  const { ref, openRef } = useDialogSync(open);

  const wide = useMediaQuery(WIDE_QUERY);
  useEffect(() => {
    if (open && wide) {
      onClose();
    }
  }, [open, wide, onClose]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: 背景の押下で閉じる操作は補助である。キーボードではEscと閉じるボタンで同じことができる。
    <dialog
      ref={ref}
      data-nav-drawer=""
      aria-label={label}
      onClose={() => {
        // 親が`open`を偽にして閉じたときは、親がすでに知っているので知らせない。
        if (openRef.current) {
          onClose();
        }
      }}
      onClick={(event) => {
        // 背景(::backdrop)の押下は、dialog自身が対象になり、座標がdialogの外になる。
        // キーボード操作が起こす押下の座標は(0, 0)で、dialogの中にあるので閉じない。
        if (event.target !== event.currentTarget) {
          return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        if (isOutsideRect({ x: event.clientX, y: event.clientY }, rect)) {
          onClose();
        }
      }}
      className="fixed inset-y-0 left-0 m-0 h-dvh max-h-none w-64 max-w-[85vw] border-r border-sidebar-border bg-sidebar p-0 text-sidebar-foreground backdrop:bg-black/50"
    >
      <div className="flex h-full flex-col">{children}</div>
    </dialog>
  );
}
