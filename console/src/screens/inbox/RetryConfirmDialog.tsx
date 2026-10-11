import { ArrowRight } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { Button } from "../../components/ui/button.tsx";
import type { RetryPlan } from "../../lib/failureView.ts";

/**
 * 再実行の確認。状態の遷移(今の状態 → 再開先)を示し、押した後に何が起きるかを伝える。
 * ブラウザ標準のdialog要素をモーダルで開くので、フォーカスの閉じ込めとEscでの取り消しは標準の動作に任せる。
 * 最初のフォーカスは「取り消す」に置く。誤って確定しないためである。
 * 取り消し(Escを含む)は`onCancel`、確定は`onConfirm`を呼ぶ。
 */
export function RetryConfirmDialog({
  open,
  title,
  plan,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  plan: RetryPlan;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId();

  useEffect(() => {
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

  return (
    <dialog
      ref={ref}
      aria-labelledby={headingId}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border border-border bg-popover p-0 text-popover-foreground shadow-raised backdrop:bg-black/40"
      onClose={onCancel}
    >
      <div className="flex flex-col gap-4 p-6">
        <h2 id={headingId} className="text-lead font-semibold">
          {title}を再実行しますか
        </h2>
        <p className="flex flex-wrap items-center gap-2 rounded-lg bg-muted px-4 py-3 text-body font-medium">
          <span className="sr-only">状態の遷移</span>
          <span>{plan.fromLabel}</span>
          <ArrowRight aria-hidden="true" className="size-4 text-subtle" />
          <span>{plan.toLabel}</span>
        </p>
        {plan.note === null ? null : (
          <p className="text-small text-muted-foreground">{plan.note}</p>
        )}
        <p className="text-small text-muted-foreground">
          作業項目のフローが稼働中のときは、再実行は断られます。結果が分からないと知らされたときは、一覧を読み直して状態を確かめてください。
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>
            取り消す
          </Button>
          <Button onClick={onConfirm}>再実行する</Button>
        </div>
      </div>
    </dialog>
  );
}
