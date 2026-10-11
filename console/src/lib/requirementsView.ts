// 要件定義の一覧と本文の画面が使う、表示用の純関数。

import type {
  RequirementsDiagram,
  RequirementsIndexRow,
} from "../api/guards/requirements.ts";
import { displayableIssueText } from "./intakeText.ts";
import { attemptRef, workItemRef, workItemStatusLabel } from "./labels.ts";
import { parseIdParam } from "./routeParams.ts";

/**
 * 一覧を作業項目の番号で絞る入力を、番号にする。
 * 先頭の`#`と前後の空白は無視する。空と、正の整数でない入力は`null`にする。
 */
export function parseWorkItemFilter(input: string): number | null {
  const trimmed = input.trim();
  return parseIdParam(trimmed.startsWith("#") ? trimmed.slice(1) : trimmed);
}

/**
 * 一覧を絞る。入力が空なら全件を返す。
 * 入力があって番号として読めないときは、どの行にも当たらないので0件にする。
 */
export function filterRequirementsRows(
  rows: readonly RequirementsIndexRow[],
  input: string,
): readonly RequirementsIndexRow[] {
  if (input.trim() === "") {
    return rows;
  }
  const workItemId = parseWorkItemFilter(input);
  return workItemId === null
    ? []
    : rows.filter((row) => row.work_item_id === workItemId);
}

/**
 * 一覧の行の題名。Issueの題名を、見えない文字を置き換えて返す。
 * 題名が空なら、Issueの番号、無ければ作業項目の番号で代える。
 */
export function requirementsRowTitle(row: RequirementsIndexRow): string {
  const title = displayableIssueText(row.title ?? "").text;
  if (title.trim() !== "") {
    return title;
  }
  return row.issue_number === null
    ? workItemRef(row.work_item_id)
    : `Issue #${row.issue_number}`;
}

export type RequirementsRowSummary = {
  /** 「owner/repo#42」の形。Issueの番号が無ければ「owner/repo」。 */
  readonly repoLabel: string;
  readonly statusLabel: string;
  readonly attemptLabel: string;
  readonly workItemLabel: string;
};

/** 一覧の行に添える、リポジトリ、状態、最新の試行、作業項目の表示。 */
export function requirementsRowSummary(
  row: RequirementsIndexRow,
): RequirementsRowSummary {
  const repo = `${row.owner}/${row.repo}`;
  return {
    repoLabel: row.issue_number === null ? repo : `${repo}#${row.issue_number}`,
    statusLabel: workItemStatusLabel(row.status),
    attemptLabel: attemptRef(row.latest_attempt),
    workItemLabel: workItemRef(row.work_item_id),
  };
}

export type StatusTone = "success" | "warning" | "failure" | "neutral";

const STATUS_TONES: ReadonlyMap<string, StatusTone> = new Map([
  ["approved", "success"],
  ["pr_open", "success"],
  ["awaiting_approval", "warning"],
  ["requirements_generating", "warning"],
  ["rejected", "failure"],
  ["needs_human", "failure"],
  ["failed", "failure"],
  ["expired", "failure"],
  ["cancelled", "failure"],
]);

/** 作業項目の状態を、バッジの色の系統にする。表に無い状態は`neutral`にする。 */
export function requirementsStatusTone(status: string): StatusTone {
  return STATUS_TONES.get(status) ?? "neutral";
}

/**
 * 要件定義書の画面のパス(routerの基準からの絶対パス)。
 * `attempt`が`null`なら最新の試行を指し、番号は付けない。
 */
export function requirementsPath(
  workItemId: number,
  attempt: number | null,
): string {
  const path = `/items/${workItemId}/requirements`;
  return attempt === null ? path : `${path}?attempt=${attempt}`;
}

export type AttemptChoice = {
  readonly attempt: number;
  readonly latest: boolean;
};

/** 試行の選択肢に並べる件数の上限。新しいほうから数える。 */
const MAX_ATTEMPT_CHOICES = 50;

/** 最新の試行の番号から、新しい順に試行の選択肢を作る。 */
export function attemptChoices(latestAttempt: number): AttemptChoice[] {
  const count = Math.min(latestAttempt, MAX_ATTEMPT_CHOICES);
  return Array.from({ length: count }, (_, index) => ({
    attempt: latestAttempt - index,
    latest: index === 0,
  }));
}

/**
 * 本文に埋め込む図の参照(`![name](name.drawio)`)の`src`の形。
 * 英小文字、数字、ハイフンで、`.drawio`で終わる。
 * 作業項目の生成側が図に付ける名前の規則と同じに保つこと。
 */
export const DRAWIO_IMAGE_SRC = /^[a-z0-9-]{1,64}\.drawio$/;

export type DiagramSlotState =
  | { readonly status: "found"; readonly xml: string }
  | { readonly status: "rejected" }
  | { readonly status: "missing" };

/**
 * 本文の図の参照に、何を出すかを決める。
 * 図があれば描く。無くても、安全の検査を通らず落とした図の名前なら「通らなかった」とし、
 * それ以外は「見つからない」とする。
 */
export function diagramSlotState(
  name: string,
  diagrams: readonly RequirementsDiagram[],
  rejected: readonly string[],
): DiagramSlotState {
  const diagram = diagrams.find((candidate) => candidate.name === name);
  if (diagram !== undefined) {
    return { status: "found", xml: diagram.xml };
  }
  return rejected.includes(name)
    ? { status: "rejected" }
    : { status: "missing" };
}

/**
 * 本文の取得元についての注記。元のファイルを読めずデータベースの控えを出しているときだけ返す。
 * 知らない値には注記を付けない。
 */
export function docSourceNotice(source: string): string | null {
  return source === "db_fallback"
    ? "元のファイルを読めなかったので、データベースの控えを表示しています。図は表示しません。"
    : null;
}
