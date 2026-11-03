import { FileText } from "lucide-react";
import { Link } from "react-router";
import type { WorkItemDetail } from "../../../api/guards/workItemDetail.ts";
import { EmptyNote } from "../../../components/EmptyNote.tsx";
import { Badge } from "../../../components/ui/badge.tsx";
import { Card } from "../../../components/ui/card.tsx";
import {
  describeDesignAttempt,
  sortDesignAttempts,
} from "../../../lib/itemDetailView.ts";
import { showsRequirementsLink } from "../../../lib/pipelineView.ts";
import { LINK_CLASS, PlainBlock, TimeLabel } from "./DetailParts.tsx";

/**
 * 設計のタブ。設計書ごとに、元の要件定義の試行と設計の試行、要約、承認の状態、設計書の画面へのリンクを出す。
 * 設計の試行の番号は、要件定義へ戻ると重なるので、行は設計書の番号で区別し、新しい設計書を先に並べる。
 * 同じ設計書へのリンクが重ならないよう、リンクは設計書ごとの1つだけにする。
 * 本文はここに埋め込まず、設計書の画面で読む。
 * 設計の入口の開閉や生成中の進行は、ここでは言わない。設定のタブと概要の進行の節が置き場所である。
 */
export function DesignTab({
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
        設計書を作るのはIssueの作業項目だけです。この作業項目には設計書がありません。
      </EmptyNote>
    );
  }
  const drafts = sortDesignAttempts(detail.design_attempts ?? []).map(
    (attempt) => describeDesignAttempt(workItemId, attempt),
  );
  if (drafts.length === 0) {
    return <EmptyNote>この作業項目には設計書がありません。</EmptyNote>;
  }
  return (
    <ul
      aria-label="設計書の一覧"
      className="flex max-w-[47.5rem] flex-col gap-3"
    >
      {drafts.map((draft) => (
        <Card
          key={draft.key}
          tag="li"
          padding="default"
          className="flex flex-col gap-2"
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Link to={draft.path} className={LINK_CLASS}>
              <FileText aria-hidden="true" className="size-4" />
              {draft.linkLabel}
            </Link>
            {draft.approvalLabel === null ? null : (
              <Badge variant={draft.approvalVariant}>
                {draft.approvalLabel}
              </Badge>
            )}
            <span className="text-small text-muted-foreground">
              <TimeLabel iso={draft.createdAt} now={now} />
            </span>
          </div>
          <PlainBlock>{draft.summary}</PlainBlock>
        </Card>
      ))}
    </ul>
  );
}
