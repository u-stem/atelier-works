import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { AUDIT_KICKOFF_CONFIRM } from "../../lib/auditKickoff.ts";

const DESCRIPTION_ID = "audit-kickoff-description";

/**
 * 監査の起動の確認。開閉とフォーカスは`ConfirmDialog`が受け持つ。
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
  return (
    <ConfirmDialog
      open={open}
      title={AUDIT_KICKOFF_CONFIRM.title}
      confirmLabel={AUDIT_KICKOFF_CONFIRM.confirmLabel}
      cancelLabel={AUDIT_KICKOFF_CONFIRM.cancelLabel}
      describedBy={DESCRIPTION_ID}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <p id={DESCRIPTION_ID} className="text-small text-muted-foreground">
        {AUDIT_KICKOFF_CONFIRM.description}
      </p>
    </ConfirmDialog>
  );
}
