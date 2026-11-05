import type { StopAllRead } from "../../api/guards/holds.ts";
import { Button } from "../../components/ui/button.tsx";
import { Card } from "../../components/ui/card.tsx";
import { STOP_ALL_TEXT } from "../../lib/labels.ts";
import { formatAbsoluteIso } from "../../lib/relativeTime.ts";
import { safeText } from "../../lib/safeText.ts";

const BIDI = "[unicode-bidi:isolate]";

type PanelProps = {
  /** 状態を返さない古いbackendの間は`undefined`で、何も描かない。 */
  readonly view: StopAllRead | undefined;
  /** 全停止か解除の書き込みが実行中。ボタンを押せなくする。 */
  readonly locked: boolean;
  readonly onRequestStop: () => void;
  readonly onRequestRelease: () => void;
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
 */
export function StopAllPanel({
  view,
  locked,
  onRequestStop,
  onRequestRelease,
}: PanelProps) {
  if (view === undefined) {
    return null;
  }
  switch (view.kind) {
    case "clear":
      return (
        <div className="flex flex-wrap items-center justify-between gap-3">
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
        <div className="flex flex-col gap-1">
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
