import { FileText } from "lucide-react";
import { Link } from "react-router";
import type { WorkItemDetail } from "../../../api/guards/workItemDetail.ts";
import { Badge } from "../../../components/ui/badge.tsx";
import { describeAttempt } from "../../../lib/itemDetailView.ts";
import { showsRequirementsLink } from "../../../lib/pipelineView.ts";
import {
  EmptyNote,
  LINK_CLASS,
  Panel,
  PlainBlock,
  TimeLabel,
} from "./DetailParts.tsx";

/**
 * 要件定義のタブ。試行ごとに、要約と承認の状態と、要件定義書の画面へのリンクを出す。
 * 同じ書類へのリンクが重ならないよう、リンクは試行ごとの1つだけにする。
 * 最新の試行のリンクは、試行の番号を付けず、常に最新を指す。
 * 本文はここに埋め込まず、要件定義書の画面で読む。
 */
export function RequirementsTab({
  detail,
  now,
}: {
  detail: WorkItemDetail;
  now: number;
}) {
  const workItemId = detail.work_item.work_item_id;
  if (!showsRequirementsLink(detail.work_item)) {
    return (
      <EmptyNote>
        要件定義を作るのはIssueの作業項目だけです。この作業項目には要件定義がありません。
      </EmptyNote>
    );
  }
  const latest = Math.max(...detail.attempts.map((attempt) => attempt.attempt));
  const attempts = detail.attempts.map((attempt) =>
    describeAttempt(workItemId, attempt, attempt.attempt === latest),
  );
  return (
    <div className="flex max-w-[47.5rem] flex-col gap-6">
      <Panel
        heading="要件定義書"
        note="試行ごとに、要約と承認の状態を並べます。新しい試行が先です。"
      >
        {attempts.length === 0 ? (
          <EmptyNote>要件定義はまだ作られていません。</EmptyNote>
        ) : (
          <ul className="flex flex-col gap-3">
            {attempts.map((attempt) => (
              <li
                key={attempt.attempt}
                className="flex flex-col gap-2 rounded-xl border border-border bg-card px-5 py-4"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Link to={attempt.path} className={LINK_CLASS}>
                    <FileText aria-hidden="true" className="size-4" />
                    {attempt.linkLabel}
                  </Link>
                  {attempt.approvalLabel === null ? null : (
                    <Badge variant={attempt.approvalVariant}>
                      {attempt.approvalLabel}
                    </Badge>
                  )}
                  <span className="text-small text-muted-foreground">
                    <TimeLabel iso={attempt.createdAt} now={now} />
                  </span>
                </div>
                <PlainBlock>{attempt.summary}</PlainBlock>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
