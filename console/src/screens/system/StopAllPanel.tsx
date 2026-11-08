import type { StopAllRead } from "../../api/guards/holds.ts";
import { Button } from "../../components/ui/button.tsx";
import { Card } from "../../components/ui/card.tsx";
import { cn } from "../../lib/cn.ts";
import { STOP_ALL_TEXT } from "../../lib/labels.ts";
import { formatAbsoluteIso } from "../../lib/relativeTime.ts";
import { safeText } from "../../lib/safeText.ts";
import {
  ANCHOR_FOCUS_CLASS,
  focusAttrs,
  highlightAttrs,
} from "./sectionAnchor.ts";
import { type SectionArrival, useSectionArrival } from "./useSectionArrival.ts";

const BIDI = "[unicode-bidi:isolate]";

type PanelProps = {
  /** 状態を返さない古いbackendの間は`undefined`で、何も描かない。 */
  readonly view: StopAllRead | undefined;
  /** 全停止か解除の書き込みが実行中。ボタンを押せなくする。 */
  readonly locked: boolean;
  readonly onRequestStop: () => void;
  readonly onRequestRelease: () => void;
  readonly arrival: SectionArrival;
};

function ReleaseButton({
  locked,
  onRequestRelease,
}: Pick<PanelProps, "locked" | "onRequestRelease">) {
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={locked}
      onClick={onRequestRelease}
    >
      {locked ? STOP_ALL_TEXT.working : STOP_ALL_TEXT.release}
    </Button>
  );
}

/**
 * システムの画面の「保留と凍結」の節の先頭に置く、全停止の区画。
 * 止まっていないときは「全停止」のボタンだけを出し、止まっているときは、置いた時刻、操作者、理由と解除のボタンを出す。
 * 読めないときは、止まっているかが分からないことを出す。
 * 理由と操作者は入力された文字列なので、`safeText`を通して文字としてだけ描く。
 * 通知から移るときの着地先で、状態ごとの根の要素がフォーカスを受ける。描かれたときに、移動を受ける。
 */
export function StopAllPanel(props: PanelProps) {
  const { view } = props;
  if (view === undefined) {
    return null;
  }
  return <StopAllBody {...props} view={view} />;
}

/** 移動を受けるフックを、区画が描かれる間だけ呼ぶために、何も描かない場合から分けた本体。 */
function StopAllBody({
  view,
  locked,
  onRequestStop,
  onRequestRelease,
  arrival,
}: Omit<PanelProps, "view"> & { view: StopAllRead }) {
  useSectionArrival("stop-all", arrival.pending, arrival.onArrived);
  const anchor = {
    ...focusAttrs("stop-all"),
    ...highlightAttrs("stop-all", arrival.highlighted),
  };
  switch (view.kind) {
    case "clear":
      return (
        <div
          {...anchor}
          className={cn(
            "flex flex-wrap items-center justify-between gap-3 rounded-xl",
            ANCHOR_FOCUS_CLASS,
          )}
        >
          <p className="text-small text-muted-foreground">
            {STOP_ALL_TEXT.clearNote}
          </p>
          <Button
            size="sm"
            variant="destructive"
            disabled={locked}
            onClick={onRequestStop}
          >
            {locked ? STOP_ALL_TEXT.working : STOP_ALL_TEXT.stop}
          </Button>
        </div>
      );
    case "active":
      return (
        <Card
          tag="section"
          padding="default"
          aria-label={STOP_ALL_TEXT.activeTitle}
          {...anchor}
          className={ANCHOR_FOCUS_CLASS}
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className="text-body font-semibold text-destructive">
                {STOP_ALL_TEXT.activeTitle}
              </p>
              <p className="text-small text-subtle">
                {`${STOP_ALL_TEXT.placedAtField}: `}
                <time dateTime={view.placed_at}>
                  {formatAbsoluteIso(view.placed_at)}
                </time>
              </p>
              <p className="text-small text-subtle">
                {`${STOP_ALL_TEXT.placedByField}: `}
                <span dir="ltr" className={`break-words ${BIDI}`}>
                  {safeText(view.placed_by)}
                </span>
              </p>
              <p
                dir="ltr"
                className={`text-small break-words whitespace-pre-wrap text-foreground ${BIDI}`}
              >
                {safeText(view.reason)}
              </p>
            </div>
            <div className="shrink-0">
              <ReleaseButton
                locked={locked}
                onRequestRelease={onRequestRelease}
              />
            </div>
          </div>
        </Card>
      );
    case "corrupt":
      return (
        <Card
          tag="section"
          padding="default"
          aria-label={STOP_ALL_TEXT.activeTitle}
          {...anchor}
          className={ANCHOR_FOCUS_CLASS}
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className="text-body font-semibold text-destructive">
                {STOP_ALL_TEXT.activeTitle}
              </p>
              <p className="text-small text-subtle">
                {STOP_ALL_TEXT.corruptNote}
              </p>
            </div>
            <div className="shrink-0">
              <ReleaseButton
                locked={locked}
                onRequestRelease={onRequestRelease}
              />
            </div>
          </div>
        </Card>
      );
    case "unreadable":
      return (
        <div
          {...anchor}
          className={cn("flex flex-col gap-1 rounded-xl", ANCHOR_FOCUS_CLASS)}
        >
          <p className="text-small text-warning">
            {`${STOP_ALL_TEXT.unreadable}: ${safeText(view.reason)}`}
          </p>
          <p className="text-small text-subtle">
            {STOP_ALL_TEXT.unreadableHostNote}
          </p>
        </div>
      );
  }
}
