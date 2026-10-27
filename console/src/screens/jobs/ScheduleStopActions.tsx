import type { ReactNode } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
  restoreDialogLines,
  type ScheduleFreeze,
  type ScheduleStopState,
  stopDialogLines,
} from "../../lib/holdPlace.ts";
import { formatShortAbsoluteIso } from "../../lib/relativeTime.ts";
import { safeText } from "../../lib/safeText.ts";

/**
 * スケジュールの行に添える、止める操作。段階は`scheduleStopState`が決める。
 * 凍結が無いうちは「止める準備」だけを出し、凍結を置いて決まった待ちが過ぎるまでは、押せない「止める」と押せる時刻を出す。
 * 止めた後は「凍結を解除して戻す」を出す。Consoleがスケジュールを戻す手段は、凍結の解除だけである。
 * ボタンは確認のダイアログを開くだけで、書き込みは確認を通った後にだけ呼ぶ。
 * 実行中(`locked`)は、どのボタンも押せなくする。
 */
export function ScheduleStopControl({
  path,
  state,
  locked,
  onPrepare,
  onStop,
  onRestore,
}: {
  path: string;
  state: ScheduleStopState;
  locked: boolean;
  onPrepare: (path: string) => void;
  onStop: (path: string, freeze: ScheduleFreeze) => void;
  onRestore: (path: string, freeze: ScheduleFreeze) => void;
}) {
  const name = safeText(path);
  switch (state.kind) {
    case "none":
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
    case "stopped":
      return (
        <Button
          variant="outline"
          size="sm"
          disabled={locked}
          aria-label={`${name}の凍結を解除して戻す`}
          onClick={() => {
            onRestore(path, state.freeze);
          }}
        >
          凍結を解除して戻す
        </Button>
      );
  }
}

type DialogTarget = {
  readonly path: string;
  readonly freeze: ScheduleFreeze;
} | null;

/** 閉じているダイアログ。中身を描かない。 */
function ClosedDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
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

/** 確認の本文。対象のパスはサーバー由来の文字列なので、`safeText`を通して文字としてだけ描く。 */
function DialogBody({
  path,
  lines,
}: {
  path: string;
  lines: readonly string[];
}): ReactNode {
  return (
    <>
      <dl className="flex flex-col gap-1">
        <div className="grid grid-cols-[6rem_1fr] gap-x-3">
          <dt className="text-small text-subtle">対象</dt>
          <dd
            dir="ltr"
            className="min-w-0 text-body break-words [unicode-bidi:isolate]"
          >
            {safeText(path)}
          </dd>
        </div>
      </dl>
      {lines.map((line) => (
        <p key={line} className="text-body">
          {line}
        </p>
      ))}
    </>
  );
}

/**
 * スケジュールを止める前の確認。確認のボタンは破壊的な色にする。Consoleからは有効に戻せないためである。
 * 止めたときの影響と、有効に戻る時期を並べる。有効なdeployの保留があれば、追従も待つので戻らない旨を添える。
 * 初期のフォーカスは、操作をやめる「取り消す」ボタンにある(`ConfirmDialog`)。
 */
export function ScheduleStopDialog({
  target,
  deployHoldActive,
  onConfirm,
  onCancel,
}: {
  target: DialogTarget;
  deployHoldActive: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (target === null) {
    return <ClosedDialog onConfirm={onConfirm} onCancel={onCancel} />;
  }
  return (
    <ConfirmDialog
      open
      title="このスケジュールを止めますか"
      confirmLabel="止める"
      destructive
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <DialogBody
        path={target.path}
        lines={stopDialogLines(
          target.path,
          target.freeze.expiresAt,
          deployHoldActive,
        )}
      />
    </ConfirmDialog>
  );
}

/**
 * 止めたスケジュールを、凍結の解除で戻す前の確認。確認のボタンは破壊的な色にしない。
 * 解除は止めが外れる向きで、期限でも必ず終わるためである。
 * 戻る時期と、有効なdeployの保留があるあいだは戻らない旨を並べる。
 */
export function ScheduleRestoreDialog({
  target,
  deployHoldActive,
  onConfirm,
  onCancel,
}: {
  target: DialogTarget;
  deployHoldActive: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (target === null) {
    return <ClosedDialog onConfirm={onConfirm} onCancel={onCancel} />;
  }
  return (
    <ConfirmDialog
      open
      title="凍結を解除してスケジュールを戻しますか"
      confirmLabel="凍結を解除"
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <DialogBody
        path={target.path}
        lines={restoreDialogLines(deployHoldActive)}
      />
    </ConfirmDialog>
  );
}
