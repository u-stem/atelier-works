import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
  type ScheduleFreeze,
  type ScheduleStopState,
  stopDialogLines,
} from "../../lib/holdPlace.ts";
import { formatShortAbsoluteIso } from "../../lib/relativeTime.ts";
import { safeText } from "../../lib/safeText.ts";

/**
 * scheduleの行に添える、止める操作。段階は`scheduleStopState`が決める。
 * 凍結が無いうちは「止める準備」だけを出し、凍結を置いて7分が過ぎるまでは、押せない「止める」と押せる時刻を出す。
 * ボタンは確認のダイアログを開くだけで、書き込みは確認を通った後にだけ呼ぶ。
 * 実行中(`locked`)は、どのボタンも押せなくする。
 */
export function ScheduleStopControl({
  path,
  state,
  locked,
  onPrepare,
  onStop,
}: {
  path: string;
  state: ScheduleStopState;
  locked: boolean;
  onPrepare: (path: string) => void;
  onStop: (path: string, freeze: ScheduleFreeze) => void;
  onRestore?: (path: string, freeze: ScheduleFreeze) => void;
}) {
  const name = safeText(path);
  switch (state.kind) {
    case "none":
    case "stopped":
      return null;
    case "prepare":
      return (
        <Button
          variant="outline"
          size="sm"
          disabled={locked}
          aria-label={`${name}を止める準備`}
          onClick={() => {
            onPrepare(path);
          }}
        >
          止める準備
        </Button>
      );
    case "waiting":
      return (
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          <Button
            variant="outline"
            size="sm"
            disabled
            aria-label={`${name}を止める`}
          >
            止める
          </Button>
          <span className="text-small text-muted-foreground">
            {`${formatShortAbsoluteIso(new Date(state.readyAt).toISOString())} 以降に止められます`}
          </span>
        </span>
      );
    case "ready":
      return (
        <Button
          variant="outline"
          size="sm"
          disabled={locked}
          aria-label={`${name}を止める`}
          onClick={() => {
            onStop(path, state.freeze);
          }}
        >
          止める
        </Button>
      );
  }
}

/**
 * scheduleを止める前の確認。確認のボタンは破壊的な色にする。Consoleからは有効に戻せないためである。
 * 止めたときの影響と、有効に戻る時期を並べる。初期のフォーカスは、操作をやめる「取り消す」ボタンにある(`ConfirmDialog`)。
 * 対象のパスはサーバー由来の文字列なので、`safeText`を通して文字としてだけ描く。
 */
export function ScheduleRestoreDialog(_props: {
  target: { readonly path: string; readonly freeze: ScheduleFreeze } | null;
  deployHoldActive: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return null;
}

export function ScheduleStopDialog({
  target,
  onConfirm,
  onCancel,
}: {
  target: { readonly path: string; readonly freeze: ScheduleFreeze } | null;
  deployHoldActive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (target === null) {
    return (
      <ConfirmDialog
        open={false}
        title=""
        confirmLabel=""
        onConfirm={onConfirm}
        onCancel={onCancel}
      >
        {null}
      </ConfirmDialog>
    );
  }
  return (
    <ConfirmDialog
      open
      title="このscheduleを止めますか"
      confirmLabel="止める"
      destructive
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <dl className="flex flex-col gap-1">
        <div className="grid grid-cols-[6rem_1fr] gap-x-3">
          <dt className="text-small text-subtle">対象</dt>
          <dd
            dir="ltr"
            className="min-w-0 text-body break-words [unicode-bidi:isolate]"
          >
            {safeText(target.path)}
          </dd>
        </div>
      </dl>
      {stopDialogLines(target.path, target.freeze.expiresAt).map((line) => (
        <p key={line} className="text-body">
          {line}
        </p>
      ))}
    </ConfirmDialog>
  );
}
