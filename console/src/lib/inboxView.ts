// 要対応の画面の一覧について、項目の型、並び、絞り込み、行の表示内容を決める純粋関数。
// 項目は承認、失敗、通知の判別可能な和で持つ。種類を足すときは、和の型と`describeRow`を直し、
// 詳細を描く画面(`screens/inbox/InboxDetail.tsx`)に分岐を足す。

import type {
  ConsoleSummary,
  SummaryApproval,
  SummaryCounts,
  SummaryFailure,
  SummaryNotice,
} from "../api/guards/summary.ts";
import {
  INBOX_KINDS,
  type InboxKind,
  type InboxSelection,
} from "./inboxSelection.ts";
import { displayableIssueText } from "./intakeText.ts";
import {
  approvalKindLabel,
  approvalStatusLabel,
  attemptRef,
  noticeKindLabel,
  workItemKindLabel,
  workItemRef,
  workItemStatusLabel,
} from "./labels.ts";
import { formatRemainingTime } from "./relativeTime.ts";
import { safeGitHubUrl } from "./safeUrl.ts";

/** 一覧の1項目。種類ごとのidは`itemId`で導く。 */
export type InboxItem =
  | { readonly type: "approval"; readonly approval: SummaryApproval }
  | { readonly type: "failure"; readonly failure: SummaryFailure }
  | { readonly type: "notice"; readonly notice: SummaryNotice };

/**
 * 項目のid。種類の中で一意で、URLの選択に使う。
 * 承認は依頼のid、失敗は作業項目のid、通知は通知のidである。
 * 値を二重に持たないよう、項目には持たせず元の行から導く。
 */
export function itemId(item: InboxItem): number {
  switch (item.type) {
    case "approval":
      return item.approval.approval_request_id;
    case "failure":
      return item.failure.work_item_id;
    case "notice":
      return item.notice.notice_id;
  }
}

/** 種類のチップ。`all`は絞り込まない。 */
export type InboxChip = "all" | InboxKind;

const KIND_ORDER: Readonly<Record<InboxKind, number>> = {
  approval: 0,
  failure: 1,
  notice: 2,
};

const CHIP_LABELS: Readonly<Record<InboxChip, string>> = {
  all: "すべて",
  approval: "承認",
  failure: "失敗",
  notice: "通知",
};

/**
 * summaryから一覧の項目を作る。
 * 通知は、詳細を描く画面ができるまで含めない。件数は`unlistedCounts`で知らせる。
 */
export function buildInboxItems(summary: ConsoleSummary): InboxItem[] {
  return [
    ...summary.approvals.map(
      (approval): InboxItem => ({ type: "approval", approval }),
    ),
    ...summary.failures.map(
      (failure): InboxItem => ({ type: "failure", failure }),
    ),
  ];
}

export function selectionOf(item: InboxItem): InboxSelection {
  return { type: item.type, id: itemId(item) };
}

/** 項目の時刻(ISO文字列)。並び順と行の相対時刻に使う。 */
function itemTime(item: InboxItem): string {
  switch (item.type) {
    case "approval":
      return item.approval.requested_at;
    case "failure":
      return item.failure.updated_at;
    case "notice":
      return item.notice.created_at;
  }
}

/** 時刻が新しい順に並べた新しい配列を返す。同時刻は種類の順(承認、失敗、通知)、次にidが大きい順にする。 */
export function sortInboxItems(items: readonly InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => {
    const byTime = Date.parse(itemTime(b)) - Date.parse(itemTime(a));
    if (byTime !== 0) {
      return byTime;
    }
    const byKind = KIND_ORDER[a.type] - KIND_ORDER[b.type];
    return byKind !== 0 ? byKind : itemId(b) - itemId(a);
  });
}

/** `chip`に当たる項目だけを、順序を保って返す。`all`は全件を返す。 */
export function filterInboxItems(
  items: readonly InboxItem[],
  chip: InboxChip,
): InboxItem[] {
  return chip === "all"
    ? [...items]
    : items.filter((item) => item.type === chip);
}

/** チップごとの件数。チップの横に出して、絞り込む前に件数が分かるようにする。 */
export function chipCounts(
  items: readonly InboxItem[],
): Record<InboxChip, number> {
  const counts: Record<InboxChip, number> = {
    all: items.length,
    approval: 0,
    failure: 0,
    notice: 0,
  };
  for (const item of items) {
    counts[item.type] += 1;
  }
  return counts;
}

/**
 * 画面に出すチップ。2種類以上の項目があるときだけ、「すべて」と項目がある種類を出す。
 * 1種類しかなければ、絞り込む意味が無いのでチップを出さない。
 * 項目が無い種類のチップを出して、空の一覧へ誘導しないためである。
 */
export function visibleChips(
  items: readonly InboxItem[],
): { id: InboxChip; label: string }[] {
  const present = new Set(items.map((item) => item.type));
  const kinds = INBOX_KINDS.filter((kind) => present.has(kind));
  if (kinds.length < 2) {
    return [];
  }
  return (["all", ...kinds] as const).map((id) => ({
    id,
    label: CHIP_LABELS[id],
  }));
}

/**
 * 描画に使うチップ。選んだ種類の項目が無くなったときは「すべて」に戻す。
 * 取り直しで項目が消えたとき、空の一覧に取り残されないためである。
 */
export function effectiveChip(
  items: readonly InboxItem[],
  chip: InboxChip,
): InboxChip {
  return chip === "all" || items.some((item) => item.type === chip)
    ? chip
    : "all";
}

/**
 * 選んだ項目が一覧に無いときに、詳細のペインに出す文。
 * 通知は一覧に載せない種類なので、処理済みとは言わない。
 */
export function missingSelectionMessage(
  selection: InboxSelection | null,
): string {
  if (selection === null) {
    return "一覧から項目を選んでください。";
  }
  return selection.type === "notice"
    ? "この種類の一覧は準備中です。"
    : "選んだ項目は一覧にありません。すでに処理されたか、まだ取得できていません。";
}

/** 選択に当たる項目を返す。選んでいないとき、または一覧に無いときは`null`。 */
export function findInboxItem(
  items: readonly InboxItem[],
  selection: InboxSelection | null,
): InboxItem | null {
  if (selection === null) {
    return null;
  }
  return (
    items.find(
      (item) => item.type === selection.type && itemId(item) === selection.id,
    ) ?? null
  );
}

/**
 * チップを切り替えた後に残す選択。チップが選択の種類を隠すときは外す。
 * 隠れた項目の詳細を出したままにしないためである。
 */
export function selectionAfterFilter(
  selection: InboxSelection | null,
  chip: InboxChip,
): InboxSelection | null {
  if (selection === null) {
    return null;
  }
  return chip === "all" || chip === selection.type ? selection : null;
}

export type ApprovalDescription = {
  readonly title: string;
  readonly kindLabel: string;
  /** 承認待ち(pending)以外の状態の語。承認待ちなら`null`。 */
  readonly statusLabel: string | null;
  readonly workItemLabel: string;
  /** 要件定義の試行。要件定義でないときは`null`。 */
  readonly attemptLabel: string | null;
  readonly issueLabel: string | null;
  /** リンクにしてよいIssueのURL。GitHubのIssueの形でなければ`null`。 */
  readonly issueUrl: string | null;
};

/**
 * 承認の1行を、詳細の概要に出す内容にする。画面は生のコードを出さず、この結果だけを描く。
 * summaryには、承認済みでIssueをまだ作っていないIssue提案も入るので、状態の語を添える。
 */
export function describeApproval(
  approval: SummaryApproval,
): ApprovalDescription {
  const title =
    approval.kind === "issue_proposal"
      ? (approval.proposal_title ?? approval.title)
      : approval.title;
  return {
    title: title ?? workItemRef(approval.work_item_id),
    kindLabel: approvalKindLabel(approval.kind, approval.origin),
    statusLabel:
      approval.status === "pending"
        ? null
        : approvalStatusLabel(approval.status, approval.kind),
    workItemLabel: workItemRef(approval.work_item_id),
    attemptLabel:
      approval.kind === "requirements" && approval.draft_attempt !== null
        ? attemptRef(approval.draft_attempt)
        : null,
    issueLabel:
      approval.issue_number === null ? null : `Issue #${approval.issue_number}`,
    issueUrl: safeGitHubUrl(approval.issue_url),
  };
}

export type ExpiryDescription = {
  /** 「残り3時間」や「期限切れ」。 */
  readonly label: string;
  readonly expired: boolean;
  /** 期限が24時間を切った(過ぎた場合を含む)。一覧で警告色の印を付ける。 */
  readonly urgent: boolean;
};

const URGENT_WITHIN_MS = 24 * 60 * 60 * 1000;

/**
 * 承認待ちの期限。承認待ち(pending)で期限があるときだけ返す。
 * 判断が済んだ行や、読めない期限は`null`にする。
 */
export function describeExpiry(
  approval: SummaryApproval,
  nowMs: number,
): ExpiryDescription | null {
  if (approval.status !== "pending" || approval.expires_at === null) {
    return null;
  }
  const expiresMs = Date.parse(approval.expires_at);
  if (Number.isNaN(expiresMs)) {
    return null;
  }
  return {
    label: formatRemainingTime(expiresMs, nowMs),
    expired: expiresMs <= nowMs,
    urgent: expiresMs - nowMs < URGENT_WITHIN_MS,
  };
}

export type RowDescription = {
  /** 一覧の行の識別子。`type:id`の形。 */
  readonly key: string;
  readonly title: string;
  readonly kindLabel: string;
  readonly statusLabel: string | null;
  readonly subLabel: string | null;
  readonly iso: string;
  readonly expiry: ExpiryDescription | null;
};

/** 一覧の1行に出す内容。期限は`nowMs`からの残りで決める。種類ごとの違いはここに閉じ込め、行の部品は種類を知らずに描く。 */
export function describeRow(item: InboxItem, nowMs: number): RowDescription {
  const key = `${item.type}:${itemId(item)}`;
  switch (item.type) {
    case "approval": {
      const description = describeApproval(item.approval);
      return {
        key,
        title: description.title,
        kindLabel: description.kindLabel,
        statusLabel: description.statusLabel,
        subLabel: description.workItemLabel,
        iso: item.approval.requested_at,
        expiry: describeExpiry(item.approval, nowMs),
      };
    }
    case "failure":
      return {
        key,
        title: displayableIssueText(
          item.failure.title ?? workItemRef(item.failure.work_item_id),
        ).text,
        kindLabel: "失敗",
        statusLabel: workItemStatusLabel(item.failure.status),
        subLabel: `${workItemKindLabel(item.failure.kind)}・${workItemRef(item.failure.work_item_id)}`,
        iso: item.failure.updated_at,
        expiry: null,
      };
    case "notice":
      return {
        key,
        title: noticeKindLabel(item.notice.kind),
        kindLabel: "通知",
        statusLabel: null,
        subLabel: null,
        iso: item.notice.created_at,
        expiry: null,
      };
  }
}

export type UnlistedCount = {
  readonly type: InboxKind;
  readonly label: string;
  readonly count: number;
};

/**
 * 一覧に出ていない件数のカードが、旧Consoleへのリンクを持つ種類か。
 * 失敗は新しい画面の一覧が受け持つので、旧Consoleへ誘導しない。
 * 残る件数は、取得の上限を超えた分だけである。
 */
export function hasLegacyLink(type: InboxKind): boolean {
  return type !== "failure";
}

/**
 * 一覧に出ていない要対応の件数を、種類ごとに返す。無ければ空の配列。
 * 件数(`counts`)は取得の上限を超えた分も数える。種類ごとに、件数から一覧にある項目を引いた差を返す。
 * 承認と失敗は上限を超えた分、通知は一覧に載せていない分である。
 */
export function unlistedCounts(
  counts: SummaryCounts,
  items: readonly InboxItem[],
): UnlistedCount[] {
  const listed = chipCounts(items);
  const entries: UnlistedCount[] = [
    {
      type: "approval",
      label: CHIP_LABELS.approval,
      count: counts.approvals - listed.approval,
    },
    {
      type: "failure",
      label: CHIP_LABELS.failure,
      count: counts.failures - listed.failure,
    },
    {
      type: "notice",
      label: CHIP_LABELS.notice,
      count: counts.notices - listed.notice,
    },
  ];
  return entries.filter((entry) => entry.count > 0);
}

/**
 * 一覧が空のときの画面の調子。
 * 何も残っていないときだけ`clear`にして成功を示し、
 * ほかの種類が残っているときは`pending`にして、片付いた印象を与えない。
 */
export function emptyStateTone(
  unlisted: readonly UnlistedCount[],
): "clear" | "pending" {
  return unlisted.length === 0 ? "clear" : "pending";
}

/**
 * 画面の見出しの副題。一覧にある項目を種類ごとの件数で伝える。
 * 一覧が空で、ほかの種類の件数も残っていなければ「すべて片付いています」にする。
 * 一覧が空でほかの種類が残っているときは、本文が伝えるので副題を出さない。
 */
export function inboxSubtitle(
  items: readonly InboxItem[],
  unlisted: readonly UnlistedCount[],
): string | null {
  if (items.length === 0) {
    return unlisted.length === 0 ? "すべて片付いています" : null;
  }
  const counts = chipCounts(items);
  return INBOX_KINDS.filter((kind) => counts[kind] > 0)
    .map((kind) => `${CHIP_LABELS[kind]} ${counts[kind]}件`)
    .join("、");
}
