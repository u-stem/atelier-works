import { Link } from "react-router";
import type { PipelineRow } from "../../api/guards/pipeline.ts";
import { TimeText } from "../../components/TimeText.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { workItemKindLabel } from "../../lib/labels.ts";
import {
  DEFAULT_PIPELINE_SORT,
  itemDetailPath,
  itemRequirementsPath,
  pipelineStatusLabel,
  pipelineStatusVariant,
  relatedLinks,
  showsRequirementsLink,
  sortPipelineRows,
} from "../../lib/pipelineView.ts";
import { ExternalLink, PlainText } from "./PipelineParts.tsx";

function PipelineCard({
  row,
  now,
  showRepository,
  backState,
}: {
  row: PipelineRow;
  now: number;
  showRepository: boolean;
  backState: { itemsBack: string } | undefined;
}) {
  const links = relatedLinks(row);
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <Link
          to={itemDetailPath(row.work_item_id)}
          state={backState}
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
        {showRepository ? (
          <>
            <dt className="text-muted-foreground">リポジトリ</dt>
            <dd className="break-all">
              {row.owner}/{row.repo}
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Issue/PR</dt>
        <dd className="flex flex-col gap-0.5">
          {links.length === 0 ? (
            <ExternalLink link={null} />
          ) : (
            links.map((link) => <ExternalLink key={link.url} link={link} />)
          )}
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
 * 取得は持たない。並びは表の並び替えによらず、常に既定の順(更新が新しい順)にする。
 * 渡された行は1ページ分で、呼び出し側が既定の順に並べた全体から区切って渡す。
 * ここでも既定の順に並べ直すので、渡す側の並びが違っても、ページの中の順は変わらない。
 * リポジトリが1つだけのときは、全カードに同じ名前が並ぶだけなので、呼び出し側が`showRepository`を偽にして省く。
 */
export function PipelineCards({
  rows,
  now,
  showRepository = true,
  backState,
}: {
  rows: readonly PipelineRow[];
  now: number;
  /** リポジトリの名前を出すか。省略すると出す。 */
  showRepository?: boolean | undefined;
  /** 詳細のパンくずが一覧へ戻るときの経路(`itemsBackState`)。省略すると既定の`/items`へ戻る。 */
  backState?: { itemsBack: string } | undefined;
}) {
  return (
    <ul className="divide-y divide-border rounded-xl border border-border bg-card">
      {sortPipelineRows(rows, DEFAULT_PIPELINE_SORT).map((row) => (
        <PipelineCard
          key={row.work_item_id}
          row={row}
          now={now}
          showRepository={showRepository}
          backState={backState}
        />
      ))}
    </ul>
  );
}
