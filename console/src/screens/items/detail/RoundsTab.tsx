import type { WorkItemDetail } from "../../../api/guards/workItemDetail.ts";
import { Badge } from "../../../components/ui/badge.tsx";
import {
  describeFixRound,
  describeReview,
  describeRound,
  groupRoundsByAttempt,
  type RoundView,
} from "../../../lib/itemDetailView.ts";
import { attemptRef } from "../../../lib/labels.ts";
import { EmptyNote, Panel, PlainBlock, TimeLabel } from "./DetailParts.tsx";

function RoundCard({ round, now }: { round: RoundView; now: number }) {
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-border bg-card px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold">{round.roundLabel}</span>
        <Badge variant="outline">{round.modeLabel}</Badge>
        <Badge variant={round.outcomeVariant}>{round.outcomeLabel}</Badge>
        {round.diffLabel === null ? null : (
          <span className="text-small text-muted-foreground tabular-nums">
            {round.diffLabel}
          </span>
        )}
        <span className="text-small text-muted-foreground">
          <TimeLabel iso={round.createdAt} now={now} />
        </span>
      </div>
      <PlainBlock>{round.summary}</PlainBlock>
      {round.gapReport === null ? null : (
        <div className="flex flex-col gap-1">
          <p className="text-small text-subtle">要件の不足の報告</p>
          <PlainBlock>{round.gapReport}</PlainBlock>
        </div>
      )}
      {round.skippedReason === null ? null : (
        <div className="flex flex-col gap-1">
          <p className="text-small text-subtle">検査を省略した理由</p>
          <PlainBlock>{round.skippedReason}</PlainBlock>
        </div>
      )}
      {round.protectedChanges.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <p className="text-small text-subtle">保護対象の変更</p>
          <ul className="font-mono text-small break-all">
            {round.protectedChanges.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

function ImplementRounds({
  detail,
  now,
}: {
  detail: WorkItemDetail;
  now: number;
}) {
  const groups = groupRoundsByAttempt(detail.implement_rounds);
  return (
    <Panel
      heading="実装のラウンド"
      note="試行ごとに、ラウンドを古い順に並べます。"
    >
      {groups.length === 0 ? (
        <EmptyNote>実装のラウンドはまだありません。</EmptyNote>
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map((group) => (
            <section
              key={group.attempt}
              aria-label={attemptRef(group.attempt)}
              className="flex flex-col gap-2"
            >
              <h3 className="text-small font-medium text-muted-foreground">
                {attemptRef(group.attempt)}
              </h3>
              <ul className="flex flex-col gap-3">
                {group.rounds.map((round) => (
                  <RoundCard
                    key={round.round_id}
                    round={describeRound(round)}
                    now={now}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Panel>
  );
}

function Reviews({ detail, now }: { detail: WorkItemDetail; now: number }) {
  const reviews = detail.reviews.map(describeReview);
  return (
    <Panel heading="PRのレビュー" note="新しい順です。">
      {reviews.length === 0 ? (
        <EmptyNote>PRのレビューはまだありません。</EmptyNote>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {reviews.map((review) => (
            <li
              key={review.key}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3"
            >
              <Badge variant={review.verdictVariant}>
                {review.verdictLabel}
              </Badge>
              <span className="text-body tabular-nums">
                {review.findingLabel}
              </span>
              <span className="font-mono text-small text-muted-foreground">
                {review.shaLabel}
              </span>
              <span className="text-small text-muted-foreground">
                <TimeLabel iso={review.createdAt} now={now} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function FixRounds({ detail, now }: { detail: WorkItemDetail; now: number }) {
  const fixRounds = detail.fix_rounds.map(describeFixRound);
  return (
    <Panel heading="PRの修正" note="新しい順です。">
      {fixRounds.length === 0 ? (
        <EmptyNote>PRの修正はまだありません。</EmptyNote>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {fixRounds.map((fixRound) => (
            <li
              key={fixRound.key}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3"
            >
              <span className="font-semibold">{fixRound.roundLabel}</span>
              <Badge variant={fixRound.outcomeVariant}>
                {fixRound.outcomeLabel}
              </Badge>
              <span className="text-small text-muted-foreground tabular-nums">
                {fixRound.countsLabel}
              </span>
              <span className="text-small text-muted-foreground">
                <TimeLabel iso={fixRound.createdAt} now={now} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * ラウンドのタブ。実装のラウンド、PRのレビュー、PRの修正を並べる。
 * レビューと修正の本文は持たず、件数と結果だけを出す。
 */
export function RoundsTab({
  detail,
  now,
}: {
  detail: WorkItemDetail;
  now: number;
}) {
  return (
    <div className="flex max-w-[47.5rem] flex-col gap-8">
      <ImplementRounds detail={detail} now={now} />
      <Reviews detail={detail} now={now} />
      <FixRounds detail={detail} now={now} />
    </div>
  );
}
