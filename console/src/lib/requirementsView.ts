// 要件定義の一覧と本文の画面が使う、表示用の純関数。

import type {
  RequirementsDiagram,
  RequirementsDoc,
  RequirementsIndexRow,
} from "../api/guards/requirements.ts";
import { displayableIssueText } from "./intakeText.ts";
import { attemptRef, workItemRef, workItemStatusLabel } from "./labels.ts";
import {
  extractHeadings,
  findTitle,
  type Heading,
} from "./markdownHeadings.ts";
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

/** 色の系統に対応するバッジの種類。色だけに頼らず、バッジの文字でも状態を伝える。 */
export function toneBadgeVariant(
  tone: StatusTone,
): "success" | "warning" | "failure" | "outline" {
  return tone === "neutral" ? "outline" : tone;
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

/**
 * 試行の選択肢を、`top`から1まで新しい順に作る。
 * `latestConfirmed`が真のときだけ、先頭を最新とする。
 * 古い試行を開いていて、最新の試行をまだ確かめられないときは偽にする。
 * 開いた試行を最新と誤って示さないためである。
 */
export function attemptChoices(
  top: number,
  latestConfirmed: boolean,
): AttemptChoice[] {
  const count = Math.min(top, MAX_ATTEMPT_CHOICES);
  return Array.from({ length: count }, (_, index) => ({
    attempt: top - index,
    latest: latestConfirmed && index === 0,
  }));
}

/**
 * 最新の試行の番号を、確かめられたときだけ返す。
 * 最新を指定して取った本文は、その試行が最新である。
 * 試行の番号を指定して取ったときは、一覧の行の最新の試行を使う。
 * 一覧がまだ答えないときと、一覧に行が無いときは`null`にする。
 * 一覧の取得後に増えた試行を見逃さないよう、開いている試行より小さい値にはしない。
 */
export function confirmedLatestAttempt(input: {
  readonly requested: number | null;
  readonly shown: number;
  readonly indexed: number | null;
}): number | null {
  if (input.requested === null) {
    return input.shown;
  }
  return input.indexed === null ? null : Math.max(input.indexed, input.shown);
}

export type AttemptParam =
  | { readonly kind: "latest" }
  | { readonly kind: "attempt"; readonly attempt: number }
  | { readonly kind: "invalid" };

/** backendが試行の番号として受け付ける最大値(32ビット符号つき整数)。 */
const MAX_ATTEMPT = 2147483647;

/**
 * URLの`attempt`の値を読む。無ければ最新を指す。
 * あって、先頭が0でない正の整数でないか、`MAX_ATTEMPT`を超えるときは不正とする。
 * 不正な値を最新として扱うと、別の試行を読んでいるのに気づけないためである。
 */
export function parseAttemptParam(raw: string | null): AttemptParam {
  if (raw === null) {
    return { kind: "latest" };
  }
  const attempt = parseIdParam(raw);
  return attempt === null || attempt > MAX_ATTEMPT
    ? { kind: "invalid" }
    : { kind: "attempt", attempt };
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

/** 絞り込みに当たる行が無いときの文。入力は空でないものを渡す。 */
export function emptyFilterMessage(input: string): string {
  const workItemId = parseWorkItemFilter(input);
  return workItemId === null
    ? "作業項目の番号は、数字で入力してください。"
    : `${workItemRef(workItemId)} の要件定義はありません。`;
}

export type PreparedDoc = {
  /** ページの見出しに出す題名。 */
  readonly title: string;
  /** 題名にした行。本文では描かない。題名が文書に無ければ`null`。 */
  readonly titleLine: number | null;
  readonly summary: string;
  readonly markdown: string;
  readonly headings: readonly Heading[];
  readonly openQuestions: readonly string[];
  /** Issueに由来する文字のうち、見えない文字を置き換えたものがあるか。 */
  readonly replaced: boolean;
};

/**
 * 要件定義書の文字を、画面に出せる形にする。
 * 本文、要約、未確定事項、題名はIssueの内容に由来するので、見えない文字を置き換える。
 * 目次と見出しの行は、置き換えた後の本文から取る。
 * 題名は本文の最初の`# `の行、無ければIssueの題名、それも無ければ「(無題)」にする。
 */
export function prepareDoc(doc: RequirementsDoc): PreparedDoc {
  const markdown = displayableIssueText(doc.markdown);
  const summary = displayableIssueText(doc.summary);
  const questions = doc.open_questions.map(displayableIssueText);
  const issueTitle = displayableIssueText(doc.title ?? "");
  const title = findTitle(markdown.text);
  const fallback = issueTitle.text.trim() === "" ? "(無題)" : issueTitle.text;
  return {
    title: title?.text ?? fallback,
    titleLine: title?.line ?? null,
    summary: summary.text,
    markdown: markdown.text,
    headings: extractHeadings(markdown.text),
    openQuestions: questions.map((question) => question.text),
    replaced:
      markdown.replaced ||
      summary.replaced ||
      issueTitle.replaced ||
      questions.some((question) => question.replaced),
  };
}
