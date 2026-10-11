import { Link } from "react-router";
import type { PipelineRow } from "../../api/guards/pipeline.ts";
import { TimeText } from "../../components/TimeText.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { workItemKindLabel } from "../../lib/labels.ts";
import {
  issueOrPrLink,
  itemDetailPath,
  itemRequirementsPath,
  pipelineStatusLabel,
  pipelineStatusVariant,
  prLink,
  showsRequirementsLink,
} from "../../lib/pipelineView.ts";
import { ExternalLink, PlainText } from "./PipelineParts.tsx";

function PipelineCard({ row, now }: { row: PipelineRow; now: number }) {
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <Link
          to={itemDetailPath(row.work_item_id)}
          className="rounded-sm font-medium tabular-nums underline underline-offset-2"
        >
          #{row.work_item_id}
        </Link>
        <Badge variant={pipelineStatusVariant(row.status)}>
          {pipelineStatusLabel(row.status)}
        </Badge>
      </div>
      <p className="break-words text-body">
        <PlainText value={row.title} />
      </p>
      <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1 text-small">
        <dt className="text-muted-foreground">種別</dt>
        <dd>{workItemKindLabel(row.kind)}</dd>
        <dt className="text-muted-foreground">リポジトリ</dt>
        <dd className="break-all">
          {row.owner}/{row.repo}
        </dd>
        <dt className="text-muted-foreground">Issue/PR</dt>
        <dd>
          <ExternalLink link={issueOrPrLink(row)} />
        </dd>
        <dt className="text-muted-foreground">PR</dt>
        <dd>
          <ExternalLink link={prLink(row.pr_url)} />
        </dd>
        <dt className="text-muted-foreground">更新</dt>
        <dd className="text-muted-foreground">
          <TimeText iso={row.updated_at} now={now} />
        </dd>
      </dl>
      {showsRequirementsLink(row) ? (
        <Link
          to={itemRequirementsPath(row.work_item_id)}
          className="self-start rounded-sm text-small underline underline-offset-2"
        >
          要件定義
        </Link>
      ) : null}
    </li>
  );
}

/**
 * 作業項目の進捗のカードの並び。幅の狭い画面で、横にスクロールする表の代わりに出す。
 * 狭い画面で要る列(状態、題名、リポジトリ、Issue/PR、更新)に絞り、ブランチと回数は詳細に任せる。
 * 取得も並び替えも持たず、渡された順に描く。
 */
export function PipelineCards({
  rows,
  now,
}: {
  rows: readonly PipelineRow[];
  now: number;
}) {
  return (
    <ul className="divide-y divide-border rounded-xl border border-border bg-card">
      {rows.map((row) => (
        <PipelineCard key={row.work_item_id} row={row} now={now} />
      ))}
    </ul>
  );
}
