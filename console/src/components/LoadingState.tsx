import type { ReactNode } from "react";
import type { LoadPhase } from "../api/sectionQuery.ts";
import { cn } from "../lib/cn.ts";
import {
  DEFAULT_DELAYED_OPTIONS,
  type DelayedOptions,
  useDelayedVisible,
} from "../lib/delayedVisible.ts";
import { Skeleton } from "./ui/skeleton.tsx";

/** 同じ高さの行を並べる形。 */
export type RowsShape = {
  readonly rows: number;
  /** 1行の高さと角の丸め。 */
  readonly rowClassName: string;
  /** 行の間隔。省略すると`gap-3`。 */
  readonly gapClassName?: string;
};

/** 画面ごとに組んだ形。`className`は枠の余白や高さ。 */
export type NodeShape = {
  readonly node: ReactNode;
  readonly className?: string;
};

/** 読み込み中の表示の形。高さを、内容の目安の高さにそろえる。 */
export type LoadingShape = RowsShape | NodeShape;

/** 読み込みの段階に応じて出すもの。 */
export type LoadingDisplay = "content" | "frame" | "skeleton";

/**
 * 読み込みの段階と、遅延表示の状態から、出すものを決める。
 * `visible`は遅延表示が「出している」状態で、取得が終わった後の残す時間も含む。
 * 残す時間の間は、値が揃っていても、スケルトンを出し続ける。
 * `lingers`が偽のときは残さず、取得が済んだらすぐ内容を出す。
 */
export function loadingDisplayOf(
  phase: LoadPhase,
  visible: boolean,
  lingers = true,
): LoadingDisplay {
  if (visible && (lingers || phase === "loading")) {
    return "skeleton";
  }
  return phase === "loading" ? "frame" : "content";
}

/**
 * 読み込みの段階から、出すものを返す。画面が早期に別の表示へ切り替えても、
 * 残す時間が続くよう、フックは画面の先頭で呼ぶ。
 */
export function useLoadingDisplay(
  phase: LoadPhase,
  options: DelayedOptions = DEFAULT_DELAYED_OPTIONS,
): LoadingDisplay {
  const visible = useDelayedVisible(phase === "loading", options);
  return loadingDisplayOf(phase, visible, options.minMs > 0);
}

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
  const className =
    "node" in shape
      ? shape.className
      : cn("flex flex-col", shape.gapClassName ?? "gap-3");
  const body =
    "node" in shape
      ? shape.node
      : Array.from({ length: shape.rows }, (_unused, index) => (
          // 行は並びが変わらない固定の数で、入れ替えも挿入もない。
          // biome-ignore lint/suspicious/noArrayIndexKey: 同上。
          <Skeleton key={index} className={shape.rowClassName} />
        ));
  return (
    <div
      {...(visible ? { role: "status" } : {})}
      className={cn(className, visible ? null : "invisible")}
    >
      {visible ? <span className="sr-only">読み込み中</span> : null}
      {body}
    </div>
  );
}

/** `display`に応じた読み込み中の表示。内容は出さない(`content`では何も描かない)。 */
export function LoadingBody({
  display,
  shape,
}: {
  display: LoadingDisplay;
  shape: LoadingShape;
}) {
  switch (display) {
    case "content":
      return null;
    case "frame":
      return <LoadingStateView visible={false} shape={shape} />;
    case "skeleton":
      return <LoadingStateView visible shape={shape} />;
  }
}

/**
 * 節の読み込み中の出し分け。
 * 取得が300ms続くまでは、スケルトンでなく同じ高さの空の枠を出し、一度出したら200ms以上残す。
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
  const display = useLoadingDisplay(phase);
  if (display === "content") {
    return children;
  }
  return <LoadingBody display={display} shape={shape} />;
}
