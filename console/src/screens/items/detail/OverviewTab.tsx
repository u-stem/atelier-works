import { Link } from "react-router";
import type { WorkItemDetail } from "../../../api/guards/workItemDetail.ts";
import { Badge } from "../../../components/ui/badge.tsx";
import {
  DETAIL_LIMITS,
  describeFailureRecord,
  describeOverview,
  describeTransition,
  detailLimitNote,
  FAILURE_ERROR_LIMIT,
} from "../../../lib/itemDetailView.ts";
import { OVERVIEW_BODY_CLASS } from "../../../lib/layoutClasses.ts";
import type { FlowProgressView } from "../../../lib/workItemFlowProgress.ts";
import {
  EmptyNote,
  JobLinks,
  LINK_CLASS,
  Panel,
  PlainBlock,
  Row,
  TargetLinkView,
  TimeLabel,
} from "./DetailParts.tsx";
import { ItemFlowProgress } from "./ItemFlowProgress.tsx";

function Summary({ detail, now }: { detail: WorkItemDetail; now: number }) {
  const view = describeOverview(detail.work_item);
  return (
    <Panel>
      <dl className="divide-y divide-border rounded-xl border border-border bg-card">
        <Row label="状態">
          <span className="flex flex-col gap-1">
            <span>
              <Badge variant={view.statusVariant}>{view.statusLabel}</Badge>
            </span>
            {view.statusNote === null ? null : (
              <PlainBlock>{view.statusNote}</PlainBlock>
            )}
          </span>
        </Row>
        <Row label="リポジトリ">{view.repoLabel}</Row>
        <Row label="Issue">
          <TargetLinkView target={view.issue} />
        </Row>
        <Row label="PR">
          <TargetLinkView target={view.pr} />
        </Row>
        <Row label="ブランチ">
          {view.branch === null ? (
            <span className="text-subtle">-</span>
          ) : (
            <span className="font-mono text-small break-all">
              {view.branch}
            </span>
          )}
        </Row>
        <Row label="試行">
          <span className="tabular-nums">{view.attempt}</span>
        </Row>
        <Row label="修正回数">
          <span className="tabular-nums">{view.fixRound}</span>
        </Row>
        <Row label="実行の費用">
          <span className="tabular-nums">{view.costLabel}</span>
        </Row>
        <Row label="作成">
          <TimeLabel iso={view.createdAt} now={now} />
        </Row>
        <Row label="更新">
          <TimeLabel iso={view.updatedAt} now={now} />
        </Row>
      </dl>
    </Panel>
  );
}

function Failures({ detail, now }: { detail: WorkItemDetail; now: number }) {
  const failures = detail.failures.map(describeFailureRecord);
  return (
    <Panel
      heading="失敗"
      note={
        <>
          新しい順の記録です。
          {detailLimitNote(detail.failures.length, DETAIL_LIMITS.failures)}
          再実行は
          <Link to="/" className={LINK_CLASS}>
            要対応の画面
          </Link>
          で行います。
        </>
      }
    >
      {failures.length === 0 ? (
        <EmptyNote>失敗の記録はありません。</EmptyNote>
      ) : (
        <ul className="flex flex-col gap-3">
          {failures.map((failure) => (
            <li
              key={failure.key}
              className="flex flex-col gap-2 rounded-xl border border-failure/30 bg-card px-5 py-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-small text-muted-foreground">
                <span className="font-mono break-all">{failure.flowLabel}</span>
                <TimeLabel iso={failure.occurredAt} now={now} />
              </div>
              <PlainBlock>{failure.error.text}</PlainBlock>
              {failure.error.truncated ? (
                <p className="text-small text-muted-foreground">
                  {`${FAILURE_ERROR_LIMIT}文字で切っています。全文はジョブの画面で確かめられます。`}
                </p>
              ) : null}
              <JobLinks jobs={failure.jobs} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Transitions({ detail, now }: { detail: WorkItemDetail; now: number }) {
  const transitions = detail.transitions.map(describeTransition);
  return (
    <Panel
      heading="状態の遷移"
      note={`新しい順です。${detailLimitNote(detail.transitions.length, DETAIL_LIMITS.transitions) ?? ""}`}
    >
      {transitions.length === 0 ? (
        <EmptyNote>状態の遷移の記録はありません。</EmptyNote>
      ) : (
        <ol className="divide-y divide-border rounded-xl border border-border bg-card">
          {transitions.map((transition) => (
            <li
              key={transition.key}
              className="flex flex-col gap-1 px-5 py-3 text-body"
            >
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                <span>
                  {transition.fromLabel === null
                    ? transition.toLabel
                    : `${transition.fromLabel} → ${transition.toLabel}`}
                </span>
                <span className="text-small text-muted-foreground">
                  <TimeLabel iso={transition.occurredAt} now={now} />
                </span>
              </div>
              {transition.note === null ? null : (
                <PlainBlock>{transition.note}</PlainBlock>
              )}
              <JobLinks jobs={transition.jobs} />
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

const NO_PROGRESS: FlowProgressView = { kind: "none" };

/**
 * 概要のタブ。状態、リンク、試行などの概要と、flowの進行、失敗の記録、状態の遷移を出す。
 * 失敗の再実行などの書き込みは置かず、要対応の画面へのリンクだけを添える。
 * 進行は、概要の取得とは別の取得なので、読めなくても概要は残る。
 */
export function OverviewTab({
  detail,
  now,
  progress = NO_PROGRESS,
}: {
  detail: WorkItemDetail;
  now: number;
  progress?: FlowProgressView;
}) {
  return (
    <div className={OVERVIEW_BODY_CLASS}>
      <Summary detail={detail} now={now} />
      <ItemFlowProgress view={progress} />
      <Failures detail={detail} now={now} />
      <Transitions detail={detail} now={now} />
    </div>
  );
}
