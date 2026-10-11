import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import type { PipelineRow } from "../../api/guards/pipeline.ts";
import { TimeText } from "../../components/TimeText.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import { workItemKindLabel } from "../../lib/labels.ts";
import {
  DEFAULT_PIPELINE_SORT,
  EMPTY_PIPELINE_FILTER,
  filterPipelineRows,
  isPipelineFilterActive,
  issueOrPrLink,
  itemDetailPath,
  itemRequirementsPath,
  nextPipelineSort,
  type PipelineFilter,
  type PipelineSort,
  type PipelineSortKey,
  pipelineStatusLabel,
  pipelineStatusVariant,
  prLink,
  reconcilePipelineFilter,
  repoOptions,
  showsRequirementsLink,
  sortPipelineRows,
  statusOptions,
} from "../../lib/pipelineView.ts";
import { PipelineCards } from "./PipelineCards.tsx";
import { ExternalLink, PlainText } from "./PipelineParts.tsx";

const FIELD_CLASS =
  "h-9 rounded-md border border-input bg-card px-2 text-body text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";

function sortIcon(sort: PipelineSort, key: PipelineSortKey) {
  if (sort.key !== key) {
    return <ChevronsUpDown aria-hidden="true" className="size-3.5" />;
  }
  return sort.direction === "asc" ? (
    <ArrowUp aria-hidden="true" className="size-3.5" />
  ) : (
    <ArrowDown aria-hidden="true" className="size-3.5" />
  );
}

function ariaSort(
  sort: PipelineSort,
  key: PipelineSortKey,
): "ascending" | "descending" | "none" {
  if (sort.key !== key) return "none";
  return sort.direction === "asc" ? "ascending" : "descending";
}

function SortableHeader({
  label,
  sortKey,
  sort,
  onSort,
  numeric = false,
}: {
  label: string;
  sortKey: PipelineSortKey;
  sort: PipelineSort;
  onSort: (key: PipelineSortKey) => void;
  numeric?: boolean;
}) {
  return (
    <th
      scope="col"
      aria-sort={ariaSort(sort, sortKey)}
      className="px-3 py-2 text-left font-medium"
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring ${numeric ? "tabular-nums" : ""}`}
      >
        {label}
        {sortIcon(sort, sortKey)}
      </button>
    </th>
  );
}

function PlainHeader({ label }: { label: string }) {
  return (
    <th
      scope="col"
      className="whitespace-nowrap px-3 py-2 text-left font-medium"
    >
      {label}
    </th>
  );
}

function FilterBar({
  rows,
  filter,
  onChange,
}: {
  rows: readonly PipelineRow[];
  filter: PipelineFilter;
  onChange: (next: PipelineFilter) => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-4">
      <label className="flex flex-col gap-1 text-small text-muted-foreground">
        状態
        <select
          className={FIELD_CLASS}
          value={filter.status ?? ""}
          onChange={(event) =>
            onChange({
              ...filter,
              status: event.target.value === "" ? null : event.target.value,
            })
          }
        >
          <option value="">すべて</option>
          {statusOptions(rows).map((status) => (
            <option key={status} value={status}>
              {pipelineStatusLabel(status)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-small text-muted-foreground">
        リポジトリ
        <select
          className={FIELD_CLASS}
          value={filter.repo ?? ""}
          onChange={(event) =>
            onChange({
              ...filter,
              repo: event.target.value === "" ? null : event.target.value,
            })
          }
        >
          <option value="">すべて</option>
          {repoOptions(rows).map((repo) => (
            <option key={repo} value={repo}>
              {repo}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-w-56 flex-1 flex-col gap-1 text-small text-muted-foreground">
        検索
        <input
          type="search"
          className={FIELD_CLASS}
          placeholder="題名、ブランチ、番号など"
          value={filter.text}
          onChange={(event) =>
            onChange({ ...filter, text: event.target.value })
          }
        />
      </label>
      {isPipelineFilterActive(filter) ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange(EMPTY_PIPELINE_FILTER)}
        >
          条件を消す
        </Button>
      ) : null}
    </div>
  );
}

function PipelineRowView({ row, now }: { row: PipelineRow; now: number }) {
  return (
    <tr className="border-t border-border align-top">
      <td className="px-3 py-2 tabular-nums">
        <Link
          to={itemDetailPath(row.work_item_id)}
          className="rounded-sm font-medium underline underline-offset-2"
        >
          #{row.work_item_id}
        </Link>
      </td>
      <td className="max-w-80 break-words px-3 py-2">
        <PlainText value={row.title} />
      </td>
      <td className="whitespace-nowrap px-3 py-2">
        {workItemKindLabel(row.kind)}
      </td>
      <td className="px-3 py-2">
        <Badge variant={pipelineStatusVariant(row.status)}>
          {pipelineStatusLabel(row.status)}
        </Badge>
      </td>
      <td className="whitespace-nowrap px-3 py-2">
        {row.owner}/{row.repo}
      </td>
      <td className="whitespace-nowrap px-3 py-2">
        <ExternalLink link={issueOrPrLink(row)} />
      </td>
      <td className="max-w-64 break-all px-3 py-2 font-mono text-small">
        <PlainText value={row.branch} />
      </td>
      <td className="whitespace-nowrap px-3 py-2">
        <ExternalLink link={prLink(row.pr_url)} />
      </td>
      <td className="px-3 py-2 tabular-nums">{row.attempt}</td>
      <td className="px-3 py-2 tabular-nums">{row.fix_round}</td>
      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
        <TimeText iso={row.updated_at} now={now} />
      </td>
      <td className="whitespace-nowrap px-3 py-2">
        {showsRequirementsLink(row) ? (
          <Link
            to={itemRequirementsPath(row.work_item_id)}
            className="rounded-sm underline underline-offset-2"
          >
            要件定義
          </Link>
        ) : (
          <span className="text-subtle">-</span>
        )}
      </td>
    </tr>
  );
}

/**
 * 作業項目の進捗の表。状態、リポジトリ、検索の文字で絞り込み、見出しを押して並べ替える。
 * 絞り込みと並び替えの規則は`lib/pipelineView.ts`の純関数にある。
 * 行の番号は作業項目の詳細へ、「要件定義」は要件定義書へ移る。
 * 取得は持たず、渡された行だけを描く。
 */
export function PipelineTable({
  rows,
  now,
}: {
  rows: readonly PipelineRow[];
  now: number;
}) {
  const [chosen, setFilter] = useState<PipelineFilter>(EMPTY_PIPELINE_FILTER);
  const filter = reconcilePipelineFilter(chosen, rows);
  if (filter !== chosen) {
    // 選んだ状態やリポジトリが再読み込みで消えたら、状態も「すべて」に揃える。
    // 描画だけを戻すと、同じ値の行が戻ったときに、操作なしで絞り込みへ戻ってしまう。
    setFilter(filter);
  }
  const [sort, setSort] = useState<PipelineSort>(DEFAULT_PIPELINE_SORT);
  const visible = sortPipelineRows(filterPipelineRows(rows, filter), sort);
  const onSort = (key: PipelineSortKey): void => {
    setSort(nextPipelineSort(sort, key));
  };

  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-border bg-card p-5 text-small text-muted-foreground">
        作業項目はまだありません
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <FilterBar rows={rows} filter={filter} onChange={setFilter} />
      <p className="text-small text-muted-foreground tabular-nums">
        {visible.length === rows.length
          ? `${rows.length}件`
          : `${visible.length}件(全${rows.length}件)`}
      </p>
      {visible.length === 0 ? (
        <p className="rounded-xl border border-border bg-card p-5 text-small text-muted-foreground">
          条件に合う作業項目はありません
        </p>
      ) : (
        <>
          <div className="md:hidden">
            <PipelineCards rows={visible} now={now} />
          </div>
          <div className="hidden overflow-x-auto rounded-xl border border-border bg-card md:block">
            <table className="w-full min-w-[72rem] border-collapse text-body">
              <thead className="text-small text-muted-foreground">
                <tr>
                  <SortableHeader
                    label="作業項目"
                    sortKey="work_item_id"
                    sort={sort}
                    onSort={onSort}
                  />
                  <PlainHeader label="題名" />
                  <PlainHeader label="種別" />
                  <SortableHeader
                    label="状態"
                    sortKey="status"
                    sort={sort}
                    onSort={onSort}
                  />
                  <SortableHeader
                    label="リポジトリ"
                    sortKey="repo"
                    sort={sort}
                    onSort={onSort}
                  />
                  <PlainHeader label="Issue/PR" />
                  <PlainHeader label="ブランチ" />
                  <PlainHeader label="PR" />
                  <SortableHeader
                    label="試行"
                    sortKey="attempt"
                    sort={sort}
                    onSort={onSort}
                    numeric
                  />
                  <SortableHeader
                    label="修正回数"
                    sortKey="fix_round"
                    sort={sort}
                    onSort={onSort}
                    numeric
                  />
                  <SortableHeader
                    label="更新"
                    sortKey="updated_at"
                    sort={sort}
                    onSort={onSort}
                  />
                  <PlainHeader label="書類" />
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <PipelineRowView key={row.work_item_id} row={row} now={now} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
