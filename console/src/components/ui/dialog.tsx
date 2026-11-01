import { cva } from "class-variance-authority";
import { type ComponentProps, type Ref, useCallback } from "react";
import { cn } from "../../lib/cn.ts";
import { notifyDialogClosed, useDialogSync } from "../useDialogSync.ts";

const dialogVariants = cva(
  "rounded-xl border border-border bg-popover p-0 text-popover-foreground shadow-raised backdrop:bg-black/50",
  {
    variants: {
      placement: {
        center: "m-auto w-[min(32rem,calc(100vw-2rem))]",
        // 入力欄を先頭に置くパレットの位置。上の端から離して、下に候補の余地を残す。
        top: "mx-auto mt-[12vh] mb-auto w-[min(36rem,calc(100vw-1rem))] overflow-hidden",
      },
    },
    defaultVariants: {
      placement: "center",
    },
  },
);

type DialogProps = Omit<
  ComponentProps<"dialog">,
  "open" | "onClose" | "ref"
> & {
  /** 開いているか。真にするとモーダルで開き、偽にすると閉じる。 */
  open: boolean;
  /** 開いた直後に1回呼ぶ。初期フォーカスの指定に使う。 */
  onOpened?: () => void;
  /**
   * 利用者の操作(Escなど)で閉じたときに呼ぶ。
   * `open`を偽にして閉じたときは、親がすでに知っているので呼ばない。
   */
  onClose: () => void;
  /** 閉じるたびに呼ぶ。`open`を偽にして閉じたときも呼ぶ。入力の消去など、閉じたら必ず要る後始末に使う。 */
  onClosed?: () => void;
  placement?: "center" | "top";
  /** 内部の同期が使う要素を、利用側も受け取る。`close()`の呼び出しや位置の計算に使う。 */
  ref?: Ref<HTMLDialogElement>;
};

/**
 * ブラウザ標準の`<dialog>`の外枠。開閉を`open`に同期し、角、面、影、背面の暗幕を決める。
 * 中の余白と並びは利用側が決める。Escで閉じ、背面の操作を止める動きは標準のものを使う。
 */
function Dialog({
  open,
  onOpened,
  onClose,
  onClosed,
  placement,
  ref,
  className,
  ...props
}: DialogProps) {
  const { ref: syncRef, openRef } = useDialogSync(open, onOpened);
  const setRef = useCallback(
    (node: HTMLDialogElement | null) => {
      syncRef.current = node;
      if (typeof ref === "function") {
        ref(node);
      } else if (ref !== undefined && ref !== null) {
        ref.current = node;
      }
    },
    [ref, syncRef],
  );
  return (
    <dialog
      ref={setRef}
      data-slot="dialog"
      onClose={() => {
        notifyDialogClosed(openRef.current, onClose, onClosed);
      }}
      className={cn(dialogVariants({ placement }), className)}
      {...props}
    />
  );
}

export type { DialogProps };
export { Dialog, dialogVariants };
