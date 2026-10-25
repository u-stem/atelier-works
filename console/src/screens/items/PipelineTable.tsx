import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { useId, useState } from "react";
import { Link } from "react-router";
import type { PipelineRow } from "../../api/guards/pipeline.ts";
import { Pagination } from "../../components/Pagination.tsx";
import { TimeText } from "../../components/TimeText.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Select } from "../../components/ui/select.tsx";
import { cn } from "../../lib/cn.ts";
import { workItemKindLabel } from "../../lib/labels.ts";
import { pageSlice } from "../../lib/pagination.ts";
import {
  DEFAULT_PIPELINE_SORT,
  EMPTY_PIPELINE_FILTER,
  filterPipelineRows,
  isPipelineFilterActive,
  itemDetailPath,
  itemRequirementsPath,
  nextPipelineSort,
  type PipelineFilter,
  type PipelineLink,
  type PipelineSort,
  type PipelineSortKey,
  pipelineStatusLabel,
  pipelineStatusVariant,
  reconcilePipelineFilter,
  relatedLinks,
  repoOptions,
  showsRequirementsLink,
  sortPipelineRows,
  statusOptions,
} from "../../lib/pipelineView.ts";
import { usePagination } from "../../lib/usePagination.ts";
import { PipelineCards } from "./PipelineCards.tsx";
import { PlainText } from "./PipelineParts.tsx";

/**
 * 表の幅が足りないときに隠す列。題名、状態、更新を先に確保するため、
 * 補助の情報であるブランチ、試行、修正回数をここに置く。
 * 幅は画面ではなく表を包む領域で測る。サイドバーの有無で使える幅が変わるためである。
 * 実測で、全列を出したときの表の最小幅は約87.5remだった。ブランチ列の最小幅に`min-w-40`を与えた状態で、
 * 実データ(リポジトリ名が約20文字)で測っている。
 * 閾値がこれより低いと、列が戻った直後に横スクロールが出るため、余裕を足して88remにしている。
 * リポジトリ名がさらに長いと、88remでも横スクロールが出ることがある。
 */
const NARROW_HIDDEN = "hidden @[88rem]:table-cell";

/**
 * 題名の列が潰れないための最小幅。
 * 表のセルへの`min-width`は効き方が仕様で定まらないので、セルの中の`div`に付ける。
 * 見出しと本文の両方の`div`に付けて、列の幅をそろえる。
 */
const TITLE_MIN_WIDTH = "min-w-56";

function ExternalLinks({ links }: { links: readonly PipelineLink[] }) {
  if (links.length === 0) {
    return <span className="text-subtle">-</span>;
  }
  return (
    <div className="flex flex-col gap-0.5">
      {links.map((link) => (
        <a
          key={link.url}
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          className="w-fit rounded-sm tabular-nums underline underline-offset-2"
        >
          {link.label}
        </a>
      ))}
    </div>
  );
}

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
  className,
}: {
  label: string;
  sortKey: PipelineSortKey;
  sort: PipelineSort;
  onSort: (key: PipelineSortKey) => void;
  numeric?: boolean;
  className?: string;
}) {
  return (
    <th
      scope="col"
      aria-sort={ariaSort(sort, sortKey)}
      className={cn("px-3 py-2 text-left font-medium", className)}
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

function PlainHeader({
  label,
  className,
  labelClassName,
}: {
  label: string;
  className?: string;
  /** 指定すると、文字を`div`で包んでクラスを付ける。セルでなく中身に最小幅を与えるときに使う。 */
  labelClassName?: string;
}) {
  return (
    <th
      scope="col"
      className={cn(
        "whitespace-nowrap px-3 py-2 text-left font-medium",
        className,
      )}
    >
      {labelClassName === undefined ? (
        label
      ) : (
        <div className={labelClassName}>{label}</div>
      )}
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
  // 自作の部品を包む`label`は、静的検査が入力欄と結べないと見なすので、`htmlFor`でも結ぶ。
  const id = useId();
  return (
    <div className="flex flex-wrap items-end gap-4">
      <label
        htmlFor={`${id}-status`}
        className="flex flex-col gap-1 text-small text-muted-foreground"
      >
        状態
        <Select
          id={`${id}-status`}
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
        </Select>
      </label>
      <label
        htmlFor={`${id}-repo`}
        className="flex flex-col gap-1 text-small text-muted-foreground"
      >
        リポジトリ
        <Select
          id={`${id}-repo`}
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
        </Select>
      </label>
      <label
        htmlFor={`${id}-text`}
        className="flex min-w-56 flex-1 flex-col gap-1 text-small text-muted-foreground"
      >
        検索
        <Input
          id={`${id}-text`}
          type="search"
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
      <td className="px-3 py-2">
        <div className={cn("max-w-lg break-words", TITLE_MIN_WIDTH)}>
          <PlainText value={row.title} />
        </div>
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
        <ExternalLinks links={relatedLinks(row)} />
      </td>
      <td className={cn("px-3 py-2 font-mono text-small", NARROW_HIDDEN)}>
        <div className="max-w-64 min-w-40 break-all">
          <PlainText value={row.branch} />
        </div>
      </td>
      <td className={cn("px-3 py-2 tabular-nums", NARROW_HIDDEN)}>
        {row.attempt}
      </td>
      <td className={cn("px-3 py-2 tabular-nums", NARROW_HIDDEN)}>
        {row.fix_round}
      </td>
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

/** 1ページに出す行の数。 */
const PAGE_SIZE = 25;

/**
 * 絞り込んだ後の行から、表とカードそれぞれの1ページ分を取り出す。
 * 表は選んだ並びで区切る。
 * カードは並び替えの操作を持たず、常に既定の順(更新が新しい順)なので、
 * 表の並びによらず、既定の順に並べてから同じページ番号で区切る。
 */
export function pipelinePageRows(
  filtered: readonly PipelineRow[],
  sort: PipelineSort,
  page: number,
): { tableRows: PipelineRow[]; cardRows: PipelineRow[] } {
  return {
    tableRows: pageSlice(sortPipelineRows(filtered, sort), page, PAGE_SIZE),
    cardRows: pageSlice(
      sortPipelineRows(filtered, DEFAULT_PIPELINE_SORT),
      page,
      PAGE_SIZE,
    ),
  };
}

/**
 * 作業項目の進捗の表。状態、リポジトリ、検索の文字で絞り込み、見出しを押して並べ替える。
 * 絞り込みと並び替えの規則は`lib/pipelineView.ts`の純関数にある。
 * 行の番号は作業項目の詳細へ、「要件定義」は要件定義書へ移る。
 * 絞り込んだ行を25件ずつのページに分ける。
 * 状態、リポジトリ、検索の文字、並び替えのどれを変えても、先頭のページへ戻る。
 * 取得は持たず、渡された行だけを描く。
 */
export function PipelineTable({
  rows,
  now,
  initialPage,
}: {
  rows: readonly PipelineRow[];
  now: number;
  /** 最初に出すページ(0から数える)。省略すると先頭。 */
  initialPage?: number | undefined;
}) {
  const [chosen, setFilter] = useState<PipelineFilter>(EMPTY_PIPELINE_FILTER);
  const filter = reconcilePipelineFilter(chosen, rows);
  const filtered = filterPipelineRows(rows, filter);
  const pager = usePagination(filtered.length, PAGE_SIZE, initialPage);
  if (filter !== chosen) {
    // 選んだ状態やリポジトリが再読み込みで消えたら、状態も「すべて」に揃える。
    // 描画だけを戻すと、同じ値の行が戻ったときに、操作なしで絞り込みへ戻ってしまう。
    // 絞り込みが変わったので、ページも先頭へ戻す。
    setFilter(filter);
    pager.reset();
  }
  const [sort, setSort] = useState<PipelineSort>(DEFAULT_PIPELINE_SORT);
  const { tableRows, cardRows } = pipelinePageRows(filtered, sort, pager.page);
  const onFilterChange = (next: PipelineFilter): void => {
    setFilter(next);
    pager.reset();
  };
  const onSort = (key: PipelineSortKey): void => {
    setSort(nextPipelineSort(sort, key));
    pager.reset();
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
      <FilterBar rows={rows} filter={filter} onChange={onFilterChange} />
      <p className="text-small text-muted-foreground tabular-nums">
        {filtered.length === rows.length
          ? `${rows.length}件`
          : `${filtered.length}件(全${rows.length}件)`}
      </p>
      {filtered.length === 0 ? (
        <p className="rounded-xl border border-border bg-card p-5 text-small text-muted-foreground">
          条件に合う作業項目はありません
        </p>
      ) : (
        <div ref={pager.anchorRef} className="flex flex-col gap-3">
          <div className="@container">
            <div className="@4xl:hidden">
              <PipelineCards rows={cardRows} now={now} />
            </div>
            <div className="@container hidden overflow-x-auto rounded-xl border border-border bg-card @4xl:block">
              <table className="w-full border-collapse text-body">
                <thead className="text-small text-muted-foreground">
                  <tr>
                    <SortableHeader
                      label="作業項目"
                      sortKey="work_item_id"
                      sort={sort}
                      onSort={onSort}
                    />
                    <PlainHeader
                      label="題名"
                      labelClassName={TITLE_MIN_WIDTH}
                    />
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
                    <PlainHeader label="ブランチ" className={NARROW_HIDDEN} />
                    <SortableHeader
                      label="試行"
                      sortKey="attempt"
                      sort={sort}
                      onSort={onSort}
                      numeric
                      className={NARROW_HIDDEN}
                    />
                    <SortableHeader
                      label="修正回数"
                      sortKey="fix_round"
                      sort={sort}
                      onSort={onSort}
                      numeric
                      className={NARROW_HIDDEN}
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
                  {tableRows.map((row) => (
                    <PipelineRowView
                      key={row.work_item_id}
                      row={row}
                      now={now}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <Pagination
            page={pager.page}
            total={filtered.length}
            size={PAGE_SIZE}
            onPageChange={pager.change}
            label="作業項目の進捗のページ送り"
          />
        </div>
      )}
    </div>
  );
}
