import { useMemo, useState } from "react";
import { toast } from "sonner";
import type { JobCancelResult } from "../../api/guards/writeResults.ts";
import {
  type JobSummaryView,
  jobDetailQueryKey,
  jobsActiveQueryKey,
} from "../../api/jobsQueries.ts";
import { useWriteMutation } from "../../api/mutations.ts";
import type { WriteRunnerConfig } from "../../api/writeRunner.ts";
import { cancelJob } from "../../api/writes.ts";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
  canCancelJob,
  cancelDialogHandlers,
  cancelDialogLines,
} from "../../lib/jobActions.ts";
import { jobScriptName } from "../../lib/jobsView.ts";
import { safeText } from "../../lib/safeText.ts";
import {
  describeJobCancelResult,
  type ReleaseNotice,
  releaseNotice,
  STALE_LIST_NOTICE,
} from "../../lib/writeNotices.ts";

function announce(notice: ReleaseNotice): void {
  switch (notice.tone) {
    case "success":
      toast.success(notice.message);
      return;
    case "info":
      toast.info(notice.message);
      return;
    case "warning":
      toast.warning(notice.message);
      return;
    case "error":
      toast.error(notice.message);
      return;
  }
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[6rem_1fr] gap-x-3">
      <dt className="text-small text-subtle">{label}</dt>
      <dd
        dir="ltr"
        className="min-w-0 text-body break-words [unicode-bidi:isolate]"
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * ジョブを中止する前の確認。確認のボタンは破壊的な色にする。止めたジョブは元に戻せないためである。
 * 対象(フローとジョブのid、作業項目)と、効果、残るもの(子プロセス、作業項目の失敗)を並べる。
 * 初期のフォーカスは、操作をやめる「取り消す」ボタンにある(`ConfirmDialog`)。
 * 行の文字列は信頼できないので、`safeText`を通して文字としてだけ描く。
 */
export function CancelDialog({
  job,
  workItemId,
  onConfirm,
  onCancel,
}: {
  job: JobSummaryView | null;
  workItemId: number | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      open={job !== null}
      title={job === null ? "" : "このジョブを中止しますか"}
      confirmLabel="中止する"
      destructive
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {job === null ? null : (
        <>
          <dl className="flex flex-col gap-1">
            <Field
              label="フロー"
              value={safeText(jobScriptName(job.script_path))}
            />
            <Field label="ジョブ" value={safeText(job.id)} />
            {workItemId === null ? null : (
              <Field label="作業項目" value={`#${String(workItemId)}`} />
            )}
          </dl>
          {cancelDialogLines(job.script_path, job.state).map((line) => (
            <p key={line} className="text-body">
              {line}
            </p>
          ))}
        </>
      )}
    </ConfirmDialog>
  );
}

/** 確認のダイアログを開くボタン。同じジョブの中止が実行中(`locked`)の間は押せない。 */
export function OpenCancelButton({
  locked,
  onOpen,
}: {
  locked: boolean;
  onOpen: () => void;
}) {
  return (
    <Button variant="outline" size="sm" disabled={locked} onClick={onOpen}>
      ジョブを中止
    </Button>
  );
}

/**
 * 中止の書き込みを、共通の流れに載せる設定。ジョブごとにロックし、中止の後は、そのジョブの詳細と実行中の一覧を読み直す。
 * 詳細は、ログと結果を含む取得だけを読み直す。状態の取得は、その値で初期化される。2つを同時に走らせないためである。
 */
function cancelConfig(
  jobId: string,
): WriteRunnerConfig<string, JobCancelResult> {
  return {
    keyOf: (id) => `job:${id}`,
    run: (id) => cancelJob(id),
    invalidates: [
      jobDetailQueryKey(jobId, { includeOutput: true }),
      jobsActiveQueryKey,
    ],
    onOutcome: (outcome) => {
      announce(releaseNotice(outcome, describeJobCancelResult));
    },
    onStale: () => {
      announce(STALE_LIST_NOTICE);
    },
  };
}

/**
 * ジョブの詳細に出す操作。中止できるジョブ(`canCancelJob`)にだけ、「ジョブを中止」を出す。
 * 押すと確認のダイアログを開く。確認を通った後にだけ、scriptを呼ぶ。URLの値や画面の遷移からは呼ばない。
 * 実行中は同じジョブのボタンを押せなくする。
 */
export function JobActions({
  job,
  workItemId,
}: {
  job: JobSummaryView;
  workItemId: number | null;
}) {
  const [open, setOpen] = useState(false);
  const config = useMemo(() => cancelConfig(job.id), [job.id]);
  const cancel = useWriteMutation(config);
  if (!canCancelJob(job)) {
    return null;
  }
  const handlers = cancelDialogHandlers({
    jobId: job.id,
    setOpen,
    submit: cancel.submit,
  });
  return (
    <>
      <OpenCancelButton
        locked={cancel.isLocked(job.id)}
        onOpen={handlers.onOpen}
      />
      <CancelDialog
        job={open ? job : null}
        workItemId={workItemId}
        onConfirm={handlers.onConfirm}
        onCancel={handlers.onDismiss}
      />
    </>
  );
}
