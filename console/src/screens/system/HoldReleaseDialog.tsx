import type { HoldItem } from "../../lib/holdsView.ts";

export function HoldReleaseDialog(_props: {
  item: HoldItem | null;
  now: number;
  otherDeployCount: number;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return <div />;
}
