import { ArrowRight } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { Button } from "../../components/ui/button.tsx";
import {
  type FailureDescription,
  RETRY_REFUSALS,
  type RetryPlan,
} from "../../lib/failureView.ts";
import { formatAbsoluteWithRelative } from "../../lib/relativeTime.ts";

/**
 * 再実行の確認。再実行する作業項目(題名、リポジトリ、対象、失敗した時刻)と、
 * 状態の遷移(今の状態 → 再開先)を示し、断られうる場合を事前に伝える。
 * 似た題名や古い表示の作業項目を取り違えないよう、対象を特定できる情報を並べる。
 * ブラウザ標準のdialog要素をモーダルで開くので、フォーカスの閉じ込めとEscでの取り消しは標準の動作に任せる。
 * 開いた直後のフォーカスは「取り消す」に置く。誤って確定しないためである。
 * 取り消し(Escを含む)は`onCancel`、確定は`onConfirm`を呼ぶ。確定では`onCancel`を呼ばない。
 */
export function RetryConfirmDialog({
  open,
  description,
  plan,
  now,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  description: FailureDescription;
  plan: RetryPlan;
  now: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const openRef = useRef(open);
  const headingId = useId();

  useEffect(() => {
    openRef.current = open;
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
      aria-labelledby={headingId}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border border-border bg-popover p-0 text-popover-foreground shadow-raised backdrop:bg-black/40"
      onClose={() => {
        // 確定や親からの閉じ込みでは、すでに開いていない。取り消しの副作用を二重に走らせない。
        if (openRef.current) {
          onCancel();
        }
      }}
    >
      <div className="flex flex-col gap-4 p-6">
        <h2 id={headingId} className="text-lead font-semibold">
          {description.workItemLabel}を再実行しますか
        </h2>
        <dl className="grid grid-cols-[6rem_1fr] gap-x-4 gap-y-1 text-small">
          <dt className="text-subtle">題名</dt>
          <dd dir="ltr" className="min-w-0 break-words [unicode-bidi:isolate]">
            {description.title}
          </dd>
          <dt className="text-subtle">リポジトリ</dt>
          <dd className="min-w-0 break-words">{description.repoLabel}</dd>
          {description.targetLabel === null ? null : (
            <>
              <dt className="text-subtle">対象</dt>
              <dd>{description.targetLabel}</dd>
            </>
          )}
          <dt className="text-subtle">{description.occurredLabel}</dt>
          <dd className="tabular-nums">
            {formatAbsoluteWithRelative(description.occurredAt, now)}
          </dd>
        </dl>
        <p className="flex flex-wrap items-center gap-2 rounded-lg bg-muted px-4 py-3 text-body font-medium">
          <span className="sr-only">状態の遷移</span>
          <span>{plan.fromLabel}</span>
          <ArrowRight aria-hidden="true" className="size-4 text-subtle" />
          <span>{plan.toLabel}</span>
        </p>
        {plan.note === null ? null : (
          <p className="text-small text-muted-foreground">{plan.note}</p>
        )}
        <div className="flex flex-col gap-1 text-small text-muted-foreground">
          <p>次のときは、再実行が断られます。</p>
          <ul className="list-disc pl-5">
            {RETRY_REFUSALS.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <p>
            断られても、「処理に失敗した可能性があります」と表示されることがあります。括弧の中の理由を読み、一覧を読み直して状態を確かめてください。
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <Button ref={cancelRef} variant="outline" onClick={onCancel}>
            取り消す
          </Button>
          <Button onClick={onConfirm}>再実行する</Button>
        </div>
      </div>
    </dialog>
  );
}
