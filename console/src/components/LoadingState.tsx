import type { ReactNode } from "react";
import type { LoadPhase } from "../api/sectionQuery.ts";

/** 読み込み中の表示の形。内容の目安の高さにそろえる。 */
export type LoadingShape = {
  readonly rows: number;
  readonly rowClassName: string;
  readonly gapClassName?: string;
};

export const OFFLINE_WAIT_TEXT = "オフラインのため、取得を待っています";

export function LoadingStateView(_props: {
  visible: boolean;
  shape: LoadingShape;
}): ReactNode {
  return null;
}

export function LoadingGate({
  children,
}: {
  phase: LoadPhase;
  shape: LoadingShape;
  children: ReactNode;
}): ReactNode {
  return <>{children}</>;
}
