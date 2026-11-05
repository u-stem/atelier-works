import { useId } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { Field } from "../../components/ui/field.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { STOP_ALL_TEXT } from "../../lib/labels.ts";
import {
  checkStopAllReason,
  STOP_ALL_EFFECT_LINES,
  STOP_ALL_REASON_MAX_LENGTH,
  STOP_ALL_RELEASE_LINES,
  stopAllReasonMessage,
} from "../../lib/stopAll.ts";

function EffectList({ id, lines }: { id: string; lines: readonly string[] }) {
  return (
    <ul id={id} className="list-disc pl-5 text-small">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

/**
 * 全停止の確認。理由を必須にし、使えない理由の間は確認のボタンを押せなくする。
 * Factory全体を止める操作なので、確認のボタンは破壊的な色にする。
 * 空の入力欄は、まだ入力していないだけなので、問題として出さない。
 */
export function StopAllDialog({
  open,
  reason,
  onReasonChange,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  reason: string;
  onReasonChange: (next: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const effectId = useId();
  const problem = checkStopAllReason(reason);
  const shown =
    problem === null || problem === "reason_empty"
      ? undefined
      : stopAllReasonMessage(problem);
  return (
    <ConfirmDialog
      open={open}
      title={STOP_ALL_TEXT.stopDialogTitle}
      describedBy={effectId}
      confirmLabel={STOP_ALL_TEXT.confirmStop}
      destructive
      confirmDisabled={problem !== null}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <EffectList id={effectId} lines={STOP_ALL_EFFECT_LINES} />
      <Field tone="filter" label={STOP_ALL_TEXT.reasonLabel} problem={shown}>
        {(control) => (
          <Textarea
            {...control}
            maxLength={STOP_ALL_REASON_MAX_LENGTH}
            value={reason}
            onChange={(event) => {
              onReasonChange(event.target.value);
            }}
          />
        )}
      </Field>
    </ConfirmDialog>
  );
}

/** 全停止の解除の確認。`*_enabled`が戻らないことを並べる。 */
export function StopAllReleaseDialog({
  open,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const effectId = useId();
  return (
    <ConfirmDialog
      open={open}
      title={STOP_ALL_TEXT.releaseDialogTitle}
      describedBy={effectId}
      confirmLabel={STOP_ALL_TEXT.confirmRelease}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <EffectList id={effectId} lines={STOP_ALL_RELEASE_LINES} />
    </ConfirmDialog>
  );
}
