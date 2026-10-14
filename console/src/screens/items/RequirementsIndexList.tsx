import { useId, useState } from "react";
import { Link } from "react-router";
import type { RequirementsIndexRow } from "../../api/guards/requirements.ts";
import { TimeText } from "../../components/TimeText.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { Input } from "../../components/ui/input.tsx";
import {
  emptyFilterMessage,
  filterRequirementsRows,
  requirementsPath,
  requirementsRowSummary,
  requirementsRowTitle,
  requirementsStatusTone,
  toneBadgeVariant,
} from "../../lib/requirementsView.ts";

function IndexRow({ row, now }: { row: RequirementsIndexRow; now: number }) {
  const summary = requirementsRowSummary(row);
  return (
    <li>
      <Link
        to={requirementsPath(row.work_item_id, null)}
        className="relative block px-6 py-3.5 outline-none transition-colors duration-150 hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none"
      >
        <span className="flex items-baseline justify-between gap-3">
          <span className="truncate text-body font-medium text-foreground">
            {requirementsRowTitle(row)}
          </span>
          <span className="shrink-0 text-small text-subtle tabular-nums">
            <TimeText iso={row.updated_at} now={now} prefix="更新 " />
          </span>
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-subtle">
          <span>{summary.repoLabel}</span>
          <span>{summary.workItemLabel}</span>
          <span>最新は{summary.attemptLabel}</span>
          <Badge variant={toneBadgeVariant(requirementsStatusTone(row.status))}>
            {summary.statusLabel}
          </Badge>
        </span>
      </Link>
    </li>
  );
}

/**
 * 要件定義がある作業項目の一覧。作業項目の番号で絞り込める。
 * 行を選ぶと、その作業項目の最新の要件定義書へ移る。
 */
export function RequirementsIndexList({
  rows,
  now,
}: {
  rows: readonly RequirementsIndexRow[];
  now: number;
}) {
  const [filter, setFilter] = useState("");
  const inputId = useId();
  const visible = filterRequirementsRows(rows, filter);
  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex items-center gap-3">
        <label htmlFor={inputId} className="text-small text-muted-foreground">
          作業項目の番号で絞り込む
        </label>
        <Input
          id={inputId}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder="空欄で全件"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="w-40"
        />
      </div>
      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-small text-muted-foreground">
          要件定義はまだありません。
        </p>
      ) : visible.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-small text-muted-foreground">
          {emptyFilterMessage(filter)}
        </p>
      ) : (
        <ul
          aria-label="要件定義の一覧"
          className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card"
        >
          {visible.map((row) => (
            <IndexRow key={row.work_item_id} row={row} now={now} />
          ))}
        </ul>
      )}
    </div>
  );
}
