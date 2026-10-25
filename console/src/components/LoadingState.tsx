import type { ReactNode } from "react";
import type { LoadPhase } from "../api/sectionQuery.ts";
import { cn } from "../lib/cn.ts";
import { useDelayedVisible } from "../lib/delayedVisible.ts";
import { Skeleton } from "./ui/skeleton.tsx";

/** 読み込み中の表示の形。行の数と高さを、内容の目安の高さにそろえる。 */
export type LoadingShape = {
  readonly rows: number;
  /** 1行の高さと角の丸め。 */
  readonly rowClassName: string;
  /** 行の間隔。省略すると`gap-3`。 */
  readonly gapClassName?: string;
};

export const OFFLINE_WAIT_TEXT = "オフラインのため、取得を待っています";

/**
 * スケルトンの枠。`visible`が偽の間は、同じ高さの空の領域として残す。
 * スケルトンが出る瞬間と、内容に置き換わる瞬間に、下の要素が動かないためである。
 * 「読み込み中」の通知は、スケルトンを見せるときだけ付ける。
 */
export function LoadingStateView({
  visible,
  shape,
}: {
  visible: boolean;
  shape: LoadingShape;
}) {
  const rows = Array.from({ length: shape.rows }, (_unused, index) => index);
  return (
    <div
      {...(visible ? { role: "status" } : {})}
      className={cn("flex flex-col", shape.gapClassName ?? "gap-3")}
    >
      {visible ? <span className="sr-only">読み込み中</span> : null}
      {rows.map((row) => (
        <Skeleton
          key={row}
          className={cn(shape.rowClassName, visible ? null : "invisible")}
        />
      ))}
    </div>
  );
}

/**
 * 節の読み込み中の出し分け。
 * 取得が300ms続くまでは、スケルトンでなく同じ高さの空の枠を出し、一度出したら200ms以上残す。
 * オフラインで止まった取得は、スケルトンを出さず、待っていることを伝える。
 * 値が揃った、または失敗したときは`children`を出す。失敗の説明は`children`が持つ。
 */
export function LoadingGate({
  phase,
  shape,
  children,
}: {
  phase: LoadPhase;
  shape: LoadingShape;
  children: ReactNode;
}) {
  const loading = phase === "loading";
  const visible = useDelayedVisible(loading);
  if (phase === "paused") {
    return (
      <p
        role="status"
        className="rounded-xl border border-border bg-card p-5 text-small text-muted-foreground"
      >
        {OFFLINE_WAIT_TEXT}
      </p>
    );
  }
  if (loading || visible) {
    return <LoadingStateView visible={visible} shape={shape} />;
  }
  return children;
}
