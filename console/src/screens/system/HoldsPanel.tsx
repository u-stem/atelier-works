import type { HoldsSnapshot } from "../../api/guards/holds.ts";
import type { HoldItem, ReleaseTarget } from "../../lib/holdsView.ts";

export function HoldsPanel(_props: {
  data: HoldsSnapshot;
  now: number;
  isLocked: (target: ReleaseTarget) => boolean;
  onRequestRelease: (item: HoldItem) => void;
  onRetry: () => void;
  isFetching: boolean;
}) {
  return <div />;
}
