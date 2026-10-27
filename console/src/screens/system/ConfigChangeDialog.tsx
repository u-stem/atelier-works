import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import type { ChangeOffer } from "../../lib/configChange.ts";

export function ConfigChangeDialog({
  offer,
  text,
  onTextChange,
  onConfirm,
  onCancel,
}: {
  offer: ChangeOffer | null;
  text: string;
  onTextChange: (text: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  void text;
  void onTextChange;
  return (
    <ConfirmDialog
      open={false}
      title=""
      confirmLabel=""
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {offer === null ? null : null}
    </ConfirmDialog>
  );
}
