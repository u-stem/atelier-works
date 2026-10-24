import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import {
  effectText,
  foreignHolderWarning,
  type HoldItem,
  remainingText,
} from "../../lib/holdsView.ts";
import { HOLDS_TEXT } from "../../lib/labels.ts";
import { formatAbsoluteIso } from "../../lib/relativeTime.ts";

function dialogTitle(item: HoldItem | null): string {
  if (item === null) {
    return "";
  }
  if (item.target.kind === "hold") {
    return HOLDS_TEXT.holdDialogTitle;
  }
  return item.category === "deploy"
    ? HOLDS_TEXT.deployDialogTitle
    : HOLDS_TEXT.freezeDialogTitle;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[6rem_1fr] gap-x-3">
      <dt className="text-small text-subtle">{label}</dt>
      <dd
        dir="ltr"
        className="min-w-0 text-body break-words [unicode-bidi:isolate]"
      >
        {value}
      </dd>
    </div>
  );
}

function Body({
  item,
  now,
  otherDeployCount,
}: {
  item: HoldItem;
  now: number;
  otherDeployCount: number;
}) {
  const warning = foreignHolderWarning(item);
  return (
    <>
      <dl className="flex flex-col gap-1">
        <Field label={HOLDS_TEXT.kindField} value={item.kindLabel} />
        <Field label={HOLDS_TEXT.targetField} value={item.targetText} />
        <Field label={HOLDS_TEXT.reasonField} value={item.reasonText} />
        <Field
          label={HOLDS_TEXT.holderField}
          value={`${item.holderLabel}(${item.holderText})`}
        />
        <Field
          label={HOLDS_TEXT.expiryField}
          value={`${formatAbsoluteIso(item.expiresAt)}(${remainingText(item.expiresAt, now)})`}
        />
        <Field
          label={HOLDS_TEXT.idField}
          value={`id ${String(item.target.id)}`}
        />
      </dl>
      <p className="text-body">{effectText(item, otherDeployCount)}</p>
      {warning === null ? null : (
        <p className="text-body font-medium text-warning">{warning}</p>
      )}
    </>
  );
}

/**
 * 保留か凍結を解除する前の確認。確認のボタンは破壊的な色にしない。
 * 解除は止めが外れる向きの操作だが、期限で必ず終わり、置き直せる。
 * 対象、理由、置いた主体、期限と、解除の効果を並べ、フォーカスは取り消しに置く。
 * 行の文字列は信頼できないので、文字としてだけ描く。
 */
export function HoldReleaseDialog({
  item,
  now,
  otherDeployCount,
  busy,
  onConfirm,
  onCancel,
}: {
  item: HoldItem | null;
  now: number;
  otherDeployCount: number;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      open={item !== null}
      title={dialogTitle(item)}
      confirmLabel={HOLDS_TEXT.confirmRelease}
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {item === null ? null : (
        <Body item={item} now={now} otherDeployCount={otherDeployCount} />
      )}
    </ConfirmDialog>
  );
}
