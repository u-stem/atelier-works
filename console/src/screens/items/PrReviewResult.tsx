import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { useJobDetail } from "../../api/jobsQueries.ts";
import { pipelineQueryKey } from "../../api/queries.ts";
import { JobLink } from "../../components/JobLink.tsx";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../../components/ui/alert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { workItemRef } from "../../lib/labels.ts";
import { itemDetailPath } from "../../lib/pipelineView.ts";
import {
  auditFailedNote,
  describePrReviewAttempt,
  type PrReviewAttempt,
} from "../../lib/prReviewOutcome.ts";
import {
  describePrReviewResult,
  offersRetry,
  type PrReviewResultState,
  prReviewResultState,
} from "../../lib/prReviewResult.ts";

const LINK_CLASS =
  "inline-flex items-center gap-1 rounded-sm font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring";

function variantOf(
  tone: "default" | "warning" | "error",
): "default" | "warning" | "destructive" {
  return tone === "error" ? "destructive" : tone;
}

/**
 * 投入の入口が返した結果の知らせ。断りと、失敗と、投入されたか分からないときに出す。
 * 起動できたときは、操作の記録を残せなかった注意だけを出す。起動後の結果は、投入したフローのジョブの結果が伝える。
 */
export function PrReviewAttemptNotice({
  attempt,
}: {
  attempt: PrReviewAttempt;
}) {
  const view = describePrReviewAttempt(attempt);
  const auditNote = auditFailedNote(attempt);
  return (
    <>
      {view === null ? null : (
        <Alert variant={variantOf(view.tone)}>
          <AlertTitle className="line-clamp-none">{view.headline}</AlertTitle>
          <AlertDescription>
            {view.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </AlertDescription>
        </Alert>
      )}
      {auditNote === null ? null : (
        <Alert variant="warning">
          <AlertDescription>
            <p>{auditNote}</p>
          </AlertDescription>
        </Alert>
      )}
    </>
  );
}

/**
 * 登録のステップの結果の表示。状態ごとに、次に開く場所を添える。
 * 始まったときは作業項目、結果を待つときと読めないときはジョブを開く。断りの文は、それだけで足りる。
 */
export function PrReviewResultPanel({
  state,
  flowJobId,
  onRetry,
  retrying,
}: {
  state: PrReviewResultState;
  flowJobId: string;
  onRetry: () => void;
  /** 取り直している間は、取り直しの操作を止める。 */
  retrying: boolean;
}) {
  const view = describePrReviewResult(state);
  const opensJob =
    state.kind === "waiting" ||
    state.kind === "unavailable" ||
    state.kind === "unreadable";
  return (
    <Alert variant={variantOf(view.tone)}>
      <AlertTitle className="line-clamp-none">{view.headline}</AlertTitle>
      <AlertDescription>
        {view.lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
        {state.kind === "started" ? (
          <Link to={itemDetailPath(state.workItemId)} className={LINK_CLASS}>
            {workItemRef(state.workItemId)}を開く
          </Link>
        ) : null}
        {opensJob ? <JobLink jobId={flowJobId} label="ジョブを開く" /> : null}
        {offersRetry(state) ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={retrying}
            onClick={onRetry}
          >
            もう一度取得する
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/**
 * 投入したフローのジョブの結果を読んで表示する。`flowJobId`があるときだけ描く。
 * 待つのは1件のジョブだけで、ジョブが終われば取り直しを止める。画面を離れたら待たない。
 * 結果を待つ間は`onWaitingChange(true)`を呼び、親が次の投入を止められるようにする。
 * 始まったと分かったとき、作業項目の一覧を1回だけ読み直す。一覧が古いままにならないためである。
 */
export function PrReviewResult({
  flowJobId,
  onWaitingChange,
}: {
  flowJobId: string;
  onWaitingChange: (waiting: boolean) => void;
}) {
  const client = useQueryClient();
  const { output, status } = useJobDetail(flowJobId);
  const state = prReviewResultState({
    output: {
      data: output.data,
      updatedAt: output.dataUpdatedAt,
      isError: output.isError,
    },
    status: { data: status.data, updatedAt: status.dataUpdatedAt },
  });

  const waiting = state.kind === "waiting";
  useEffect(() => {
    onWaitingChange(waiting);
    return () => {
      onWaitingChange(false);
    };
  }, [waiting, onWaitingChange]);

  const started = state.kind === "started";
  const refreshedFor = useRef<string | null>(null);
  useEffect(() => {
    if (started && refreshedFor.current !== flowJobId) {
      refreshedFor.current = flowJobId;
      void client.invalidateQueries({ queryKey: pipelineQueryKey });
    }
  }, [started, flowJobId, client]);

  return (
    <PrReviewResultPanel
      state={state}
      flowJobId={flowJobId}
      retrying={output.isFetching}
      onRetry={() => {
        void output.refetch();
      }}
    />
  );
}
