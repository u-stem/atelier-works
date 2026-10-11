import { type ReactNode, useEffect, useRef } from "react";
import { Button } from "./ui/button.tsx";

/**
 * 取り消せない操作の確認ダイアログ。ブラウザ標準の`<dialog>`をモーダルで開く。
 * Escで閉じ、背面の操作を止め、フォーカスをダイアログの中に留める。
 * 開いたら、取り消しのボタンにフォーカスを置く。Enterの押し間違いで実行させないためである。
 */
export function ConfirmDialog({
  open,
  title,
  confirmLabel,
  destructive = false,
  busy,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  confirmLabel: string;
  /** 確認のボタンを、破壊的な操作の色にする。 */
  destructive?: boolean;
  /** 実行中。確認のボタンを押せなくする。 */
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
      cancelRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="confirm-dialog-title"
      onClose={onCancel}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border border-border bg-popover p-0 text-popover-foreground shadow-md backdrop:bg-black/50"
    >
      <div className="flex flex-col gap-4 p-6">
        <h2 id="confirm-dialog-title" className="text-lead font-semibold">
          {title}
        </h2>
        <div className="flex flex-col gap-2 text-body">{children}</div>
        <div className="flex justify-end gap-2">
          <Button ref={cancelRef} variant="outline" onClick={onCancel}>
            取り消す
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
