import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import type {
  JobCancelResult,
  JobRerunResult,
} from "../../api/guards/writeResults.ts";
import {
  type JobSummaryView,
  jobDetailQueryKey,
  jobsActiveQueryKey,
  schedulesQueryKey,
} from "../../api/jobsQueries.ts";
import { useWriteMutation } from "../../api/mutations.ts";
import type { WriteRunnerConfig } from "../../api/writeRunner.ts";
import { cancelJob, rerunJob } from "../../api/writes.ts";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
  canCancelJob,
  cancelDialogHandlers,
  cancelDialogLines,
  canRerunJob,
  rerunDialogLines,
} from "../../lib/jobActions.ts";
import { jobDetailPath } from "../../lib/jobLink.ts";
import { jobScriptName } from "../../lib/jobsView.ts";
import { safeText } from "../../lib/safeText.ts";
import {
  describeJobCancelResult,
  describeJobRerunResult,
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
 * 失敗した定期ジョブを再実行する前の確認。再実行は新しいジョブを始めるだけで、失敗したジョブを書き換えないので、
 * 確認のボタンは破壊的な色にしない。対象(処理と失敗したジョブのid)と、効果、再実行しない場合を並べる。
 * 初期のフォーカスは、操作をやめる「取り消す」ボタンにある(`ConfirmDialog`)。
 * 行の文字列は信頼できないので、`safeText`を通して文字としてだけ描く。
 */
export function RerunDialog({
  job,
  onConfirm,
  onCancel,
}: {
  job: JobSummaryView | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      open={job !== null}
      title={job === null ? "" : "この定期ジョブを再実行しますか"}
      confirmLabel="再実行する"
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {job === null ? null : (
        <>
          <dl className="flex flex-col gap-1">
            <Field
              label="処理"
              value={safeText(jobScriptName(job.script_path))}
            />
            <Field label="失敗したジョブ" value={safeText(job.id)} />
          </dl>
          {rerunDialogLines(job.script_path).map((line) => (
            <p key={line} className="text-body">
              {line}
            </p>
          ))}
        </>
      )}
    </ConfirmDialog>
  );
}

/** 確認のダイアログを開くボタン。同じジョブの再実行が実行中(`locked`)の間は押せない。 */
export function OpenRerunButton({
  locked,
  onOpen,
}: {
  locked: boolean;
  onOpen: () => void;
}) {
  return (
    <Button variant="outline" size="sm" disabled={locked} onClick={onOpen}>
      ジョブを再実行
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
 * 再実行の書き込みを、共通の流れに載せる設定。ジョブごとにロックし、再実行の後は、実行中の一覧とscheduleの直近の実行を読み直す。
 * 起動できたときは、結果を読む新しいジョブの詳細へ移る。再実行の失敗は定期の失敗の通知に載らないので、その画面で確かめる。
 */
function rerunConfig(
  navigate: (to: string) => void | Promise<void>,
): WriteRunnerConfig<string, JobRerunResult> {
  return {
    keyOf: (id) => `job-rerun:${id}`,
    run: (id) => rerunJob(id),
    invalidates: [jobsActiveQueryKey, schedulesQueryKey],
    onOutcome: (outcome) => {
      announce(releaseNotice(outcome, describeJobRerunResult));
      if (
        outcome.kind === "done" &&
        outcome.result.found &&
        !outcome.result.refused
      ) {
        const path = jobDetailPath(outcome.result.job_id);
        if (path !== null) {
          void navigate(path);
        }
      }
    },
    onStale: () => {
      announce(STALE_LIST_NOTICE);
    },
  };
}

/**
 * ジョブの詳細に出す操作。中止できるジョブ(`canCancelJob`)には「ジョブを中止」を、
 * 再実行できる失敗した定期ジョブ(`canRerunJob`)には「ジョブを再実行」を出す。
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
  const navigate = useNavigate();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [rerunOpen, setRerunOpen] = useState(false);
  const cancelSettings = useMemo(() => cancelConfig(job.id), [job.id]);
  const rerunSettings = useMemo(() => rerunConfig(navigate), [navigate]);
  const cancel = useWriteMutation(cancelSettings);
  const rerun = useWriteMutation(rerunSettings);
  if (canCancelJob(job)) {
    const handlers = cancelDialogHandlers({
      jobId: job.id,
      setOpen: setCancelOpen,
      submit: cancel.submit,
    });
    return (
      <>
        <OpenCancelButton
          locked={cancel.isLocked(job.id)}
          onOpen={handlers.onOpen}
        />
        <CancelDialog
          job={cancelOpen ? job : null}
          workItemId={workItemId}
          onConfirm={handlers.onConfirm}
          onCancel={handlers.onDismiss}
        />
      </>
    );
  }
  if (canRerunJob(job)) {
    // 確認の流れは中止と同じ。開くだけで、書き込みは確認を通った後(`onConfirm`)にだけ呼ぶ。
    const handlers = cancelDialogHandlers({
      jobId: job.id,
      setOpen: setRerunOpen,
      submit: rerun.submit,
    });
    return (
      <>
        <OpenRerunButton
          locked={rerun.isLocked(job.id)}
          onOpen={handlers.onOpen}
        />
        <RerunDialog
          job={rerunOpen ? job : null}
          onConfirm={handlers.onConfirm}
          onCancel={handlers.onDismiss}
        />
      </>
    );
  }
  return null;
}
