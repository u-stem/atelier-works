import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  type HistoryFilter,
  isLaterHistoryPage,
  type JobListView,
  jobHistoryQueryOptions,
} from "../../api/jobsQueries.ts";
import type { SectionQuery } from "../../api/sectionQuery.ts";
import { useNow } from "../../app/useNow.ts";
import { QueryFailureAlert } from "../../components/QueryFailureAlert.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Select } from "../../components/ui/select.tsx";
import {
  type HistoryStatus,
  historyEndNote,
  historyTotal,
  jobScriptName,
  parseHistoryScript,
  parseHistoryStatus,
} from "../../lib/jobsView.ts";
import { EmptyNote } from "../system/SystemSection.tsx";
import { JobList, JobsQueryGate, LIST_LOADING_SHAPE } from "./JobRows.tsx";

/** 履歴の読み込み済みのページと、その取得の状態。 */
export type HistoryData = {
  /** 読み込み済みのページ。新しい順に並ぶ。 */
  readonly pages: readonly JobListView[];
  /** 先頭のページの取得。取得中と失敗は、この結果が決める。 */
  readonly first: SectionQuery<JobListView>;
  /** 2ページ目以降の最後の取得。先頭のページだけのときは`null`。 */
  readonly more: SectionQuery<JobListView> | null;
  /** 続きを読み込めるか。 */
  readonly canLoadMore: boolean;
  readonly loadMore: () => void;
  /** 先頭のページから読み直す。 */
  readonly refresh: () => void;
};

/**
 * 履歴を、絞り込みごとに先頭から読み、「さらに読み込む」で続きを足す。
 * カーソルは画面で組み立てず、サーバーが返す`next_before`をそのまま使う。
 * 絞り込みが変わると、先頭のページから読み直す。
 * 読み直しは、2ページ目以降のキャッシュを捨てる。先頭が新しくなった後に、古いカーソルの続きを混ぜないためである。
 * `enabled`が偽の間は取得しない。開いていないタブの取得を避ける。
 */
export function useJobHistory(
  filter: { readonly status?: string; readonly scriptPath?: string },
  enabled: boolean,
): HistoryData {
  const client = useQueryClient();
  const filterKey = `${filter.status ?? ""}|${filter.scriptPath ?? ""}`;
  const [state, setState] = useState<{
    readonly key: string;
    readonly cursors: readonly string[];
  }>({ key: filterKey, cursors: [] });
  // 絞り込みが変わった描画では、前の絞り込みのカーソルを使わない。
  const cursors = state.key === filterKey ? state.cursors : [];
  if (state.key !== filterKey) {
    setState({ key: filterKey, cursors: [] });
  }

  const results = useQueries({
    queries: [undefined, ...cursors].map((before) => {
      const pageFilter: HistoryFilter = {
        ...(filter.status === undefined ? {} : { status: filter.status }),
        ...(filter.scriptPath === undefined
          ? {}
          : { scriptPath: filter.scriptPath }),
        ...(before === undefined ? {} : { before }),
      };
      return { ...jobHistoryQueryOptions(pageFilter), enabled };
    }),
  });

  const pages: JobListView[] = [];
  for (const result of results) {
    if (result.data === undefined) break;
    pages.push(result.data);
  }
  const first = results[0];
  const last = results.at(-1);
  const nextBefore = last?.data?.next_before ?? null;

  return {
    pages,
    first: first ?? EMPTY_QUERY,
    more: results.length > 1 && last !== undefined ? last : null,
    canLoadMore: nextBefore !== null && last?.isFetching !== true,
    loadMore: () => {
      if (nextBefore !== null) {
        setState({ key: filterKey, cursors: [...cursors, nextBefore] });
      }
    },
    refresh: () => {
      client.removeQueries({
        queryKey: ["console", "jobs", "history"],
        predicate: (query) => isLaterHistoryPage(query.queryKey),
      });
      setState({ key: filterKey, cursors: [] });
      void first?.refetch();
    },
  };
}

const EMPTY_QUERY: SectionQuery<JobListView> = {
  data: undefined,
  isError: false,
  error: null,
  isFetching: false,
  refetch: () => Promise.resolve(undefined),
};

const STATUS_OPTIONS: readonly (readonly [HistoryStatus | "", string])[] = [
  ["", "すべて"],
  ["success", "成功"],
  ["failure", "失敗"],
];

function Filters({
  status,
  script,
  scripts,
  onStatusChange,
  onScriptChange,
}: {
  status: HistoryStatus | undefined;
  script: string | undefined;
  scripts: readonly string[];
  onStatusChange: (status: HistoryStatus | undefined) => void;
  onScriptChange: (script: string | undefined) => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
      <div className="flex flex-col gap-1">
        <label
          htmlFor="jobs-history-status"
          className="text-small text-muted-foreground"
        >
          状態
        </label>
        <Select
          id="jobs-history-status"
          value={status ?? ""}
          onChange={(event) => {
            onStatusChange(parseHistoryStatus(event.target.value));
          }}
        >
          {STATUS_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <label
          htmlFor="jobs-history-script"
          className="text-small text-muted-foreground"
        >
          script
        </label>
        <Select
          id="jobs-history-script"
          className="max-w-full"
          value={script ?? ""}
          onChange={(event) => {
            onScriptChange(parseHistoryScript(event.target.value, scripts));
          }}
        >
          <option value="">すべてのscript</option>
          {scripts.map((path) => (
            <option key={path} value={path}>
              {jobScriptName(path)}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}

/**
 * 履歴のタブの本体。状態とscriptで絞り込み、完了したジョブを新しい順に並べる。
 * 絞り込みはURLに持つので、親が値と変更の関数を渡す。
 * 続きは「さらに読み込む」で足し、累積200件で止まる。止まったときは、絞り込みを変えて探すよう伝える。
 * 2ページ目以降の取得に失敗しても、読み込み済みの行は残す。
 */
export function JobHistory({
  history,
  status,
  script,
  scripts,
  onStatusChange,
  onScriptChange,
  search,
}: {
  history: HistoryData;
  status: HistoryStatus | undefined;
  script: string | undefined;
  scripts: readonly string[];
  onStatusChange: (status: HistoryStatus | undefined) => void;
  onScriptChange: (script: string | undefined) => void;
  /** 一覧の`location.search`。詳細のパンくずが同じ範囲へ戻るために使う。 */
  search: string;
}) {
  const now = useNow();
  const { pages, more } = history;
  const jobs = pages.flatMap((page) => page.jobs);
  const endNote = historyEndNote(pages);
  const rejected = pages.at(-1)?.filter_rejected === true;
  const loadingMore = more?.isFetching === true;
  return (
    <div className="flex max-w-4xl flex-col gap-3">
      <p className="text-small text-muted-foreground">
        完了したジョブを新しい順に表示します。Consoleの呼び出し(tag
        console)は含みません。自動では更新しません。
      </p>
      <Filters
        status={status}
        script={script}
        scripts={scripts}
        onStatusChange={onStatusChange}
        onScriptChange={onScriptChange}
      />
      <JobsQueryGate
        query={history.first}
        title="ジョブの履歴を取得できませんでした"
        loginHint="上のバナーからログインすると、ジョブの履歴を表示します。"
        shape={LIST_LOADING_SHAPE}
      >
        {() => (
          <>
            {jobs.length === 0 ? (
              <EmptyNote>
                {rejected
                  ? "指定したscriptは、既知のscriptにありません。絞り込みを外してください。"
                  : "条件に合うジョブはありません。"}
              </EmptyNote>
            ) : (
              <>
                <JobList jobs={jobs} now={now} back={search} time="history" />
                <p className="text-small text-muted-foreground tabular-nums">
                  {historyTotal(pages)}件を表示しています。
                </p>
              </>
            )}
            {more !== null && more.data === undefined && more.isError ? (
              <QueryFailureAlert
                title="続きを取得できませんでした"
                error={more.error}
                onRetry={() => {
                  void more.refetch();
                }}
              />
            ) : null}
            {history.canLoadMore || loadingMore ? (
              <div>
                <Button
                  variant="outline"
                  aria-disabled={loadingMore}
                  onClick={loadingMore ? undefined : history.loadMore}
                >
                  {loadingMore ? "読み込み中…" : "さらに読み込む"}
                </Button>
              </div>
            ) : null}
            {endNote === null ? null : (
              <p className="text-small text-muted-foreground">{endNote}</p>
            )}
          </>
        )}
      </JobsQueryGate>
    </div>
  );
}
