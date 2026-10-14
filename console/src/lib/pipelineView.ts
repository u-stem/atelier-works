// 作業項目の進捗の表を決める純粋関数。
// 絞り込み、並び替え、状態の見た目、リンクと移動先を決める。画面は描くだけにする。

import type { PipelineRow } from "../api/guards/pipeline.ts";
import { displayableIssueText } from "./intakeText.ts";
import {
  UNKNOWN_STATUS_LABEL,
  workItemKindLabel,
  workItemStatusLabel,
} from "./labels.ts";
import { safeGitHubUrl } from "./safeUrl.ts";

/**
 * 状態を作業の進む順に並べた一覧。選択肢と並び替えの順になる。
 * ここに無い状態(backendが先に足した新しい値)は、既知の状態の後ろに回す。
 */
const STATUS_ORDER: readonly string[] = [
  "picked",
  "requirements_generating",
  "awaiting_approval",
  "approved",
  "rejected",
  "implementing",
  "pr_open",
  "reviewing",
  "reviewed",
  "fixing",
  "rereview_requested",
  "auditing",
  "audited",
  "blocked",
  "needs_human",
  "failed",
  "expired",
  "cancelled",
];

function statusRank(status: string): number {
  const index = STATUS_ORDER.indexOf(status);
  return index === -1 ? STATUS_ORDER.length : index;
}

function isKnownStatus(status: string): boolean {
  return STATUS_ORDER.includes(status);
}

function compareStatus(a: string, b: string): number {
  const byRank = statusRank(a) - statusRank(b);
  if (byRank !== 0) return byRank;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 「owner/repo」の形のリポジトリ名。 */
function repoName(row: Pick<PipelineRow, "owner" | "repo">): string {
  return `${row.owner}/${row.repo}`;
}

/** 絞り込みの選択肢にする状態。作業の進む順に並べ、同じ状態は1つにする。 */
export function statusOptions(rows: readonly PipelineRow[]): string[] {
  return Array.from(new Set(rows.map((row) => row.status))).sort(compareStatus);
}

/** 絞り込みの選択肢にするリポジトリ。名前順に並べ、同じリポジトリは1つにする。 */
export function repoOptions(rows: readonly PipelineRow[]): string[] {
  return Array.from(new Set(rows.map(repoName))).sort();
}

export type PipelineFilter = {
  /** 選んだ状態。`null`はすべて。 */
  readonly status: string | null;
  /** 選んだリポジトリ(`owner/repo`)。`null`はすべて。 */
  readonly repo: string | null;
  /** 検索の文字列。空白で区切った語がすべて当たる行を残す。 */
  readonly text: string;
};

export const EMPTY_PIPELINE_FILTER: PipelineFilter = {
  status: null,
  repo: null,
  text: "",
};

/** 絞り込みが1つでも効いているか。空白だけの検索は効いていないものとして扱う。 */
export function isPipelineFilterActive(filter: PipelineFilter): boolean {
  return (
    filter.status !== null ||
    filter.repo !== null ||
    filter.text.trim().length > 0
  );
}

/**
 * 状態の表示名。知らない状態は、日本語の名前が無いので、生の値を添える。
 * 新しい状態をbackendが先に足した間も、どの状態か見分けられるようにするためである。
 * 生の値は見えない文字を落としてから添える。
 */
export function pipelineStatusLabel(status: string): string {
  const label = workItemStatusLabel(status);
  if (label !== UNKNOWN_STATUS_LABEL) return label;
  return `${label}(${displayableIssueText(status).text})`;
}

/**
 * 選択肢から消えた状態とリポジトリの選択を、「すべて」に戻した絞り込みを返す。
 * 再読み込みで行が入れ替わると、選んでいた値が表から消えうる。
 * そのまま残すと、選択肢の表示は「すべて」なのに絞り込みだけが効き続け、行が出ない理由が見えなくなる。
 * 戻すものが無ければ、渡された絞り込みをそのまま返す。検索の文字列は変えない。
 */
export function reconcilePipelineFilter(
  filter: PipelineFilter,
  rows: readonly PipelineRow[],
): PipelineFilter {
  const statusGone =
    filter.status !== null && !rows.some((row) => row.status === filter.status);
  const repoGone =
    filter.repo !== null && !rows.some((row) => repoName(row) === filter.repo);
  if (!statusGone && !repoGone) return filter;
  return {
    status: statusGone ? null : filter.status,
    repo: repoGone ? null : filter.repo,
    text: filter.text,
  };
}

/**
 * 検索の対象にする文字列。画面に出す語(題名、ブランチ、リポジトリ、番号、状態、種別)だけを並べる。
 * 題名とブランチは、画面に出すときと同じ整形を通す。見えない文字が検索に当たらないようにするため。
 */
function searchableText(row: PipelineRow): string {
  const parts = [
    `#${row.work_item_id}`,
    repoName(row),
    pipelineStatusLabel(row.status),
    workItemKindLabel(row.kind),
  ];
  if (row.title !== null) parts.push(displayableIssueText(row.title).text);
  if (row.branch !== null) parts.push(displayableIssueText(row.branch).text);
  if (row.issue_number !== null) parts.push(`#${row.issue_number}`);
  if (row.pr_number !== null) parts.push(`PR #${row.pr_number}`);
  return parts.join("\n").toLowerCase();
}

/** `filter`に当たる行だけを、元の順序のまま返す。`rows`は変えない。 */
export function filterPipelineRows(
  rows: readonly PipelineRow[],
  filter: PipelineFilter,
): PipelineRow[] {
  const terms = filter.text
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  return rows.filter((row) => {
    if (filter.status !== null && row.status !== filter.status) return false;
    if (filter.repo !== null && repoName(row) !== filter.repo) return false;
    if (terms.length === 0) return true;
    const haystack = searchableText(row);
    return terms.every((term) => haystack.includes(term));
  });
}

export type PipelineSortKey =
  | "work_item_id"
  | "status"
  | "repo"
  | "attempt"
  | "fix_round"
  | "updated_at";

export type PipelineSortDirection = "asc" | "desc";

export type PipelineSort = {
  readonly key: PipelineSortKey;
  readonly direction: PipelineSortDirection;
};

/** 既定の並びは、更新が新しい順。 */
export const DEFAULT_PIPELINE_SORT: PipelineSort = {
  key: "updated_at",
  direction: "desc",
};

function compareByKey(
  a: PipelineRow,
  b: PipelineRow,
  key: PipelineSortKey,
): number {
  switch (key) {
    case "work_item_id":
      return a.work_item_id - b.work_item_id;
    case "status":
      return compareStatus(a.status, b.status);
    case "repo": {
      const left = repoName(a);
      const right = repoName(b);
      return left < right ? -1 : left > right ? 1 : 0;
    }
    case "attempt":
      return a.attempt - b.attempt;
    case "fix_round":
      return a.fix_round - b.fix_round;
    case "updated_at":
      // オフセットの違う表記が混ざっても時刻の前後で比べるため、文字列でなく時刻にする。
      return Date.parse(a.updated_at) - Date.parse(b.updated_at);
  }
}

/**
 * `rows`を並べ替えた新しい配列を返す。`rows`は変えない。
 * 状態で並べるときは、知らない状態を向きによらず最後に置く。
 * 並びが同じ行は、新しい作業項目(番号が大きい方)を先にする。向きを変えても、同点の順は変わらない。
 */
export function sortPipelineRows(
  rows: readonly PipelineRow[],
  sort: PipelineSort,
): PipelineRow[] {
  const sign = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (sort.key === "status") {
      const knownA = isKnownStatus(a.status);
      const knownB = isKnownStatus(b.status);
      if (knownA !== knownB) return knownA ? -1 : 1;
    }
    const result = compareByKey(a, b, sort.key) * sign;
    if (result !== 0) return result;
    return b.work_item_id - a.work_item_id;
  });
}

/**
 * 見出しを押したときの次の並び。
 * 同じ列を続けて押すと向きを反転し、別の列を押すと、その列の最初に見たい向きから始める。
 * 数と時刻は大きい方(新しい方)から、状態とリポジトリは先頭から始める。
 */
export function nextPipelineSort(
  current: PipelineSort,
  key: PipelineSortKey,
): PipelineSort {
  if (current.key === key) {
    return {
      key,
      direction: current.direction === "asc" ? "desc" : "asc",
    };
  }
  const textual = key === "status" || key === "repo";
  return { key, direction: textual ? "asc" : "desc" };
}

/** 状態の表示の色。`Badge`の`variant`の名前に合わせている。 */
export type PipelineStatusVariant = "warning" | "success" | "failure" | "muted";

const SUCCESS_STATUSES: ReadonlySet<string> = new Set([
  "approved",
  "reviewed",
  "audited",
  "pr_open",
]);
const FAILURE_STATUSES: ReadonlySet<string> = new Set([
  "failed",
  "blocked",
  "needs_human",
]);

/**
 * 状態を表示の色に分ける。承認待ちは警告、完了に近い状態は成功、失敗と人の対応待ちは失敗、それ以外は枠の無い灰色にする。
 * 色だけに頼らず、状態の名前を隣に出す。
 */
export function pipelineStatusVariant(status: string): PipelineStatusVariant {
  if (status === "awaiting_approval") return "warning";
  if (SUCCESS_STATUSES.has(status)) return "success";
  if (FAILURE_STATUSES.has(status)) return "failure";
  return "muted";
}

export type PipelineLink = { readonly label: string; readonly url: string };

/**
 * 関連リンクの列に並べるリンク。IssueのリンクがあればPRのリンクより前に置く。
 * IssueはURLと番号が揃うときだけ、PRは記録したURLを先に、無ければPR番号から組み立てて指す。
 * GitHubのIssueやPRの形でないURLは、リンクにせず落とす。
 * 壊れたIssueのURLがあっても、PRのリンクは残す。
 */
export function relatedLinks(
  row: Pick<
    PipelineRow,
    "issue_url" | "issue_number" | "pr_url" | "pr_number" | "owner" | "repo"
  >,
): PipelineLink[] {
  const links: PipelineLink[] = [];
  if (row.issue_url !== null && row.issue_number !== null) {
    const url = safeGitHubUrl(row.issue_url);
    if (url !== null) links.push({ label: `#${row.issue_number}`, url });
  }
  const recorded = prLink(row.pr_url);
  if (recorded !== null) {
    links.push(recorded);
  } else if (row.pr_number !== null) {
    const url = safeGitHubUrl(
      `https://github.com/${row.owner}/${row.repo}/pull/${row.pr_number}`,
    );
    if (url !== null) links.push({ label: `PR #${row.pr_number}`, url });
  }
  return links;
}

/** PRのURLからリンクを作る。PRのURLの形でなければ`null`を返す。 */
export function prLink(prUrl: string | null): PipelineLink | null {
  const url = safeGitHubUrl(prUrl);
  if (url === null) return null;
  const match = /\/pull\/([1-9][0-9]*)$/.exec(url);
  return match === null ? null : { label: `PR #${match[1]}`, url };
}

/** 作業項目の詳細の経路。routerの基準(`/console`)からの絶対パスで書く。 */
export function itemDetailPath(workItemId: number): string {
  return `/items/${workItemId}`;
}

/** 作業項目の要件定義書の経路。 */
export function itemRequirementsPath(workItemId: number): string {
  return `/items/${workItemId}/requirements`;
}

/** 要件定義書へのリンクを出す行か。要件定義を作るのはIssueの作業項目だけである。 */
export function showsRequirementsLink(row: Pick<PipelineRow, "kind">): boolean {
  return row.kind === "issue";
}

/**
 * 表が見ている範囲の注記。
 * 取得の上限に達したときは、古い行が漏れているかもしれないので、件数の上限も添える。
 */
export function pipelineScopeNote(
  count: number,
  limit: number,
  days: number,
): string {
  return count >= limit
    ? `直近${days}日に更新された作業項目を、新しい順に${limit}件まで取得しています。`
    : `直近${days}日に更新された作業項目を表示しています。`;
}
