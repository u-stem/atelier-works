import { useEffect, useRef } from "react";
import { Button } from "../../components/ui/button.tsx";
import { AUDIT_KICKOFF_CONFIRM } from "../../lib/auditKickoff.ts";

/**
 * 監査の起動の確認。ブラウザ標準の`<dialog>`をモーダルで開く。
 * フォーカスの閉じ込めと、Escでの取り消しはブラウザが行う。
 * 確認と取り消しのどちらでも、呼び出し側が`open`を落として閉じる。
 */
export function KickoffConfirmDialog({
  open,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="audit-kickoff-title"
      aria-describedby="audit-kickoff-description"
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border border-border bg-popover p-0 text-popover-foreground shadow-raised backdrop:bg-black/50"
      onCancel={(event) => {
        // Escで閉じるときも、状態を先に戻す。ブラウザの閉じる動作は止めて、状態の変化に任せる。
        event.preventDefault();
        onCancel();
      }}
    >
      <div className="flex flex-col gap-4 px-6 py-5">
        <h2 id="audit-kickoff-title" className="text-lead font-semibold">
          {AUDIT_KICKOFF_CONFIRM.title}
        </h2>
        <p
          id="audit-kickoff-description"
          className="text-small text-muted-foreground"
        >
          {AUDIT_KICKOFF_CONFIRM.description}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>
            {AUDIT_KICKOFF_CONFIRM.cancelLabel}
          </Button>
          <Button onClick={onConfirm}>
            {AUDIT_KICKOFF_CONFIRM.confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
