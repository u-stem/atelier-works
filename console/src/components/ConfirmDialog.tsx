import { type ReactNode, useCallback, useId, useRef } from "react";
import { Button } from "./ui/button.tsx";
import { Dialog } from "./ui/dialog.tsx";
import { focusElement } from "./useDialogSync.ts";

/**
 * 取り消せない操作の確認ダイアログ。ブラウザ標準の`<dialog>`をモーダルで開く。
 * Escで閉じ、背面の操作を止め、フォーカスをダイアログの中に留める。
 * 開いたら、取り消しのボタンにフォーカスを置く。Enterの押し間違いで実行させないためである。
 * 取り消し(Escを含む)は`onCancel`、確定は`onConfirm`を呼ぶ。確定では`onCancel`を呼ばない。
 * 本文のうち、ダイアログの説明になる要素があれば、その`id`を`describedBy`に渡す。
 */
export function ConfirmDialog({
  open,
  title,
  confirmLabel,
  cancelLabel = "取り消す",
  describedBy,
  destructive = false,
  busy = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  confirmLabel: string;
  /** 取り消しのボタンの文言。 */
  cancelLabel?: string;
  /** ダイアログの説明になる要素の`id`。読み上げが、タイトルの後に続けて読む。 */
  describedBy?: string;
  /** 確認のボタンを、破壊的な操作の色にする。 */
  destructive?: boolean;
  /** 実行中。確認のボタンを押せなくする。 */
  busy?: boolean;
  /** 入力が整っていない。確認のボタンを押せなくする。実行中(`busy`)とは別の理由で押せないことを表す。 */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const focusCancel = useCallback(() => {
    focusElement(cancelRef.current);
  }, []);
  return (
    // 確定や親からの閉じ込みでは、取り消しを呼ばない。取り消しの副作用を二重に走らせないためである。
    <Dialog
      open={open}
      onOpened={focusCancel}
      onClose={onCancel}
      aria-labelledby={headingId}
      aria-describedby={describedBy}
    >
      <div className="flex flex-col gap-4 p-6">
        <h2 id={headingId} className="text-lead font-semibold">
          {title}
        </h2>
        <div className="flex flex-col gap-2 text-body">{children}</div>
        <div className="flex justify-end gap-2">
          <Button ref={cancelRef} variant="outline" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={busy || confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
