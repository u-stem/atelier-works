import { ExternalLink, RotateCw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link } from "react-router";
import type { SummaryFailure } from "../../api/guards/summary.ts";
import { JobLink } from "../../components/JobLink.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
  describeFailure,
  describeRetryPlan,
  FAILURE_TEXT_LIMIT,
  workItemPath,
} from "../../lib/failureView.ts";
import { formatAbsoluteWithRelative } from "../../lib/relativeTime.ts";
import { RetryConfirmDialog } from "./RetryConfirmDialog.tsx";
import { useRetryWorkItem } from "./useRetryWorkItem.ts";

const LINK_CLASS =
  "inline-flex items-center gap-1 rounded-sm font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] items-baseline gap-x-4 px-5 py-3">
      <dt className="text-small text-subtle">{label}</dt>
      <dd className="min-w-0 text-body break-words text-foreground">
        {children}
      </dd>
    </div>
  );
}

/**
 * 再実行の枠。確認を経て、この作業項目だけを再実行する。
 * ボタンの状態は作業項目のロックから決める。ほかの失敗の行の再実行には影響されない。
 * 再実行できない種類(監査)には、理由だけを出す。
 */
function RetrySection({ failure }: { failure: SummaryFailure }) {
  const [confirming, setConfirming] = useState(false);
  const { submit, isLocked } = useRetryWorkItem();
  const description = describeFailure(failure);
  const plan = describeRetryPlan(failure);
  const input = { workItemId: failure.work_item_id };
  const locked = isLocked(input);

  return (
    <section
      aria-label="再実行"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card px-5 py-4"
    >
      <h3 className="text-lead font-semibold">再実行</h3>
      {plan.blockedReason === null ? (
        <>
          <p className="text-small text-muted-foreground">
            止まった作業項目を再開します。押すと、状態の遷移を確かめる画面を開きます。
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={locked}
              onClick={() => {
                setConfirming(true);
              }}
            >
              <RotateCw aria-hidden="true" />
              {locked ? "処理中" : "再実行"}
            </Button>
            {locked ? (
              <p className="text-small text-muted-foreground" role="status">
                この作業項目の処理が終わり、一覧が更新されるまで、押せません。
              </p>
            ) : null}
          </div>
          <RetryConfirmDialog
            open={confirming}
            title={description.workItemLabel}
            plan={plan}
            onCancel={() => {
              setConfirming(false);
            }}
            onConfirm={() => {
              setConfirming(false);
              submit(input);
            }}
          />
        </>
      ) : (
        <p className="text-small text-muted-foreground">{plan.blockedReason}</p>
      )}
    </section>
  );
}

/**
 * 選んだ失敗の詳細。題名、種類、状態、作業項目への経路、対象のリンク、失敗の時刻とジョブ、失敗の内容、再実行を出す。
 * 失敗の内容は、実行の出力でありIssueの文字を含みうるので、プレーンテキストで描く。
 * 作業項目ごとに1行で、直近の失敗の記録だけを持つ。
 */
export function FailureOverview({
  failure,
  now,
}: {
  failure: SummaryFailure;
  now: number;
}) {
  const description = describeFailure(failure);
  return (
    <article className="flex max-w-[47.5rem] flex-col gap-6 p-8">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={description.statusTone}>
            {description.statusLabel}
          </Badge>
          <Badge variant="outline">{description.kindLabel}</Badge>
        </div>
        <h2
          dir="ltr"
          className="text-display font-semibold tracking-tight text-balance [unicode-bidi:isolate]"
        >
          {description.title}
        </h2>
      </header>
      <dl className="divide-y divide-border rounded-xl border border-border bg-card">
        <Row label="作業項目">
          <Link to={workItemPath(failure.work_item_id)} className={LINK_CLASS}>
            {description.workItemLabel}
          </Link>
        </Row>
        <Row label="リポジトリ">{description.repoLabel}</Row>
        {description.targetLabel === null ? null : (
          <Row label="対象">
            {description.targetUrl === null ? (
              description.targetLabel
            ) : (
              <a
                href={description.targetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={LINK_CLASS}
              >
                {description.targetLabel}
                <ExternalLink aria-hidden="true" className="size-3.5" />
              </a>
            )}
          </Row>
        )}
        <Row label="失敗した時刻">
          <time dateTime={description.occurredAt} className="tabular-nums">
            {formatAbsoluteWithRelative(description.occurredAt, now)}
          </time>
        </Row>
        {description.flowLabel === null ? null : (
          <Row label="フロー">
            <span className="font-mono text-small">
              {description.flowLabel}
            </span>
          </Row>
        )}
        {description.jobId === null ? null : (
          <Row label="ジョブ">
            <JobLink jobId={description.jobId} label="ジョブを開く" />
          </Row>
        )}
      </dl>
      <section
        aria-label="失敗の内容"
        className="rounded-xl border border-border bg-card"
      >
        <h3 className="border-b border-border px-5 py-3 text-lead font-semibold">
          失敗の内容
        </h3>
        <div className="flex flex-col gap-3 px-5 py-4">
          {description.error === null ? (
            <p className="text-small text-muted-foreground">
              この作業項目に、失敗の記録はありません。
            </p>
          ) : (
            <>
              <pre
                dir="ltr"
                className="max-h-96 overflow-auto rounded-lg bg-muted px-4 py-3 font-mono text-small break-words whitespace-pre-wrap text-foreground [unicode-bidi:isolate]"
              >
                {description.error.text}
              </pre>
              {description.error.truncated ? (
                <p className="text-small text-warning">
                  先頭の{FAILURE_TEXT_LIMIT}
                  字だけを表示しています。全文はジョブのログで確かめられます。
                </p>
              ) : null}
            </>
          )}
          {description.statusNote === null ? null : (
            <div className="flex flex-col gap-1">
              <p className="text-small text-subtle">状態が変わったときの注記</p>
              <p
                dir="ltr"
                className="text-body break-words whitespace-pre-wrap text-foreground [unicode-bidi:isolate]"
              >
                {description.statusNote}
              </p>
            </div>
          )}
        </div>
      </section>
      <RetrySection failure={failure} />
    </article>
  );
}
