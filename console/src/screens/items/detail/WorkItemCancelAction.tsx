import { useMemo, useState } from "react";
import type { WorkItemCancelResult } from "../../../api/guards/writeResults.ts";
import { useWriteMutation } from "../../../api/mutations.ts";
import { summaryQueryKey } from "../../../api/queries.ts";
import { workItemDetailQueryKey } from "../../../api/workItemDetailQueries.ts";
import type { WriteRunnerConfig } from "../../../api/writeRunner.ts";
import { cancelWorkItem } from "../../../api/writes.ts";
import { announce, announceStaleList } from "../../../components/announce.ts";
import { ConfirmDialog } from "../../../components/ConfirmDialog.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { workItemRef } from "../../../lib/labels.ts";
import {
  canCancelWorkItem,
  cancelWorkItemDialogLines,
  type WorkItemCancelInput,
  workItemCancelKey,
} from "../../../lib/workItemCancel.ts";
import {
  describeWorkItemCancelResult,
  releaseNotice,
} from "../../../lib/writeNotices.ts";

/**
 * 中止の確認のダイアログの固定の設定。確認は破壊的な操作として渡す。中止した作業項目は再開できないためである。
 * やめるボタンは「閉じる」にする。既定の「取り消す」は、作業項目を取り消す操作と読み違えるためである。
 */
export const WORK_ITEM_CANCEL_CONFIRM: {
  readonly title: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly destructive: boolean;
} = {
  title: "この作業項目を中止しますか",
  confirmLabel: "中止する",
  cancelLabel: "閉じる",
  destructive: true,
};

/**
 * 作業項目を中止する前の確認。
 * 対象の作業項目と、効果、残るもの、拾い直されない条件を並べる。
 * 初期のフォーカスは、操作をやめる「閉じる」ボタンにある(`ConfirmDialog`)。
 */
export function WorkItemCancelDialog({
  open,
  workItemId,
  kind,
  status,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  workItemId: number;
  kind: string;
  status: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      open={open}
      title={open ? WORK_ITEM_CANCEL_CONFIRM.title : ""}
      confirmLabel={WORK_ITEM_CANCEL_CONFIRM.confirmLabel}
      cancelLabel={WORK_ITEM_CANCEL_CONFIRM.cancelLabel}
      destructive={WORK_ITEM_CANCEL_CONFIRM.destructive}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {open ? (
        <>
          <p className="text-body">{`作業項目 #${String(workItemId)}`}</p>
          {cancelWorkItemDialogLines(kind, status).map((line) => (
            <p key={line} className="text-body">
              {line}
            </p>
          ))}
        </>
      ) : null}
    </ConfirmDialog>
  );
}

/**
 * 中止の書き込みを、共通の流れに載せる設定。作業項目ごとにロックし、中止の後は、その作業項目の詳細とsummaryを読み直す。
 * ロックのキーは再実行と同じで、同じ作業項目の再実行と中止を同時に送らない。
 */
function cancelConfig(
  workItemId: number,
): WriteRunnerConfig<WorkItemCancelInput, WorkItemCancelResult> {
  return {
    keyOf: workItemCancelKey,
    run: (input) => cancelWorkItem(input.workItemId),
    invalidates: [workItemDetailQueryKey(workItemId), summaryQueryKey],
    onOutcome: (outcome, input) => {
      announce(releaseNotice(outcome, describeWorkItemCancelResult), {
        description: workItemRef(input.workItemId),
      });
    },
    onStale: (input) => {
      announceStaleList({ description: workItemRef(input.workItemId) });
    },
  };
}

/**
 * 作業項目の詳細の概要に出す「作業項目を中止」。種別と状態が中止の表にあるときだけ出す。
 * 押すと確認のダイアログを開く。確認を通った後にだけ、scriptを呼ぶ。URLの値や画面の遷移からは呼ばない。
 * 実行中は同じ作業項目のボタンを押せなくする。表はscriptも強制するので、ボタンを隠すことは守りではない。
 */
export function WorkItemCancelAction({
  workItemId,
  kind,
  status,
}: {
  workItemId: number;
  kind: string;
  status: string;
}) {
  const [open, setOpen] = useState(false);
  const settings = useMemo(() => cancelConfig(workItemId), [workItemId]);
  const cancel = useWriteMutation(settings);
  if (!canCancelWorkItem(kind, status)) {
    return null;
  }
  const input: WorkItemCancelInput = { workItemId };
  return (
    <div className="flex justify-end">
      <Button
        variant="outline"
        size="sm"
        disabled={cancel.isLocked(input)}
        onClick={() => {
          setOpen(true);
        }}
      >
        作業項目を中止
      </Button>
      <WorkItemCancelDialog
        open={open}
        workItemId={workItemId}
        kind={kind}
        status={status}
        onConfirm={() => {
          setOpen(false);
          cancel.submit(input);
        }}
        onCancel={() => {
          setOpen(false);
        }}
      />
    </div>
  );
}
