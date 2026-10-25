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
import { SYSTEM_PATH } from "../app/paths.ts";
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
  workItemKindLabel,
  workItemRef,
  workItemStatusLabel,
} from "./labels.ts";
import {
  describeNotice,
  type NoticeDescription,
  shortSha,
} from "./noticeView.ts";
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
 * summaryから一覧の項目を作る。承認、失敗、通知の順に並べる。
 * 監査の失敗は再実行できないので含めない。
 */
export function buildInboxItems(summary: ConsoleSummary): InboxItem[] {
  return [
    ...summary.approvals.map(
      (approval): InboxItem => ({ type: "approval", approval }),
    ),
    ...summary.failures
      .filter((failure) => failure.kind !== "audit")
      .map((failure): InboxItem => ({ type: "failure", failure })),
    ...summary.notices.map((notice): InboxItem => ({ type: "notice", notice })),
  ];
}

/**
 * summaryの失敗のうち、監査の失敗の数。
 * 監査は再実行できず、次の定期の監査が扱うので、一覧の行にもバッジにも数えない。
 * 取得の上限を超えた分は見えないので、見えている行だけを数える。
 */
export function auditFailureCount(summary: ConsoleSummary): number {
  return summary.failures.filter((failure) => failure.kind === "audit").length;
}

/**
 * バッジと、一覧に出ていない件数に使う件数。失敗は、再実行できるもの(監査を除く)だけを数える。
 * 数え続けて0にならない件数を、最初に見る場所に出さないためである。
 */
export function actionableCounts(summary: ConsoleSummary): SummaryCounts {
  return {
    ...summary.counts,
    failures: Math.max(0, summary.counts.failures - auditFailureCount(summary)),
  };
}

export function openAuditFailureCount(_summary: ConsoleSummary): number {
  return 0;
}

export function actionableTotal(_summary: ConsoleSummary): number {
  return 0;
}

export const INBOX_PATH = "";

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
 */
export function missingSelectionMessage(
  selection: InboxSelection | null,
): string {
  if (selection === null) {
    return "一覧から項目を選んでください。";
  }
  return selection.type === "notice"
    ? "選んだ通知は一覧にありません。すでに解決されたか、まだ取得できていません。"
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
  /** 種別の語。通知と失敗の固定の語は、省くとき(`showKind`が偽)に`null`になる。 */
  readonly kindLabel: string | null;
  readonly statusLabel: string | null;
  readonly subLabel: string | null;
  /** 副題の全文。副題が本文を省いたときに、省いた分も読めるようにする。無ければ`null`。 */
  readonly subTitle: string | null;
  readonly iso: string;
  readonly expiry: ExpiryDescription | null;
};

/**
 * 通知と失敗の固定の語(「通知」「失敗」)を省いてよい一覧か。
 * すべて通知、またはすべて失敗のとき、全行に同じ語が付いて情報にならない。
 * 承認の語は要件定義、Issue化提案、改善提案などの区別を担うので、省かない。
 */
export function omitsKindLabels(items: readonly InboxItem[]): boolean {
  return (
    items.length > 0 &&
    (items.every((item) => item.type === "notice") ||
      items.every((item) => item.type === "failure"))
  );
}

/** 副題に出す本文の文字数(コードポイント)。 */
const EXCERPT_LENGTH = 36;

/** 本文の食い違いを、抜粋の先頭からこの文字数だけ手前に置く。前後の言葉で違いを読めるようにする。 */
const EXCERPT_LEAD = 8;

/** 通知の行に出す副題と、その全文。 */
type NoticeRowText = {
  readonly subLabel: string | null;
  readonly subTitle: string | null;
};

type NoticeEntry = {
  readonly notice: SummaryNotice;
  readonly description: NoticeDescription;
};

/** 本文の全体。版は先頭7桁に縮めてある。 */
function shortenedMessage(description: NoticeDescription): string {
  return description.messageParts.map((part) => part.text).join("");
}

/**
 * 副題の抜粋の元になる本文。版は先頭7桁に縮め、空白と改行は1つの空白にまとめる。
 * `cutTarget`が真のとき、副題に出す先頭の対象を、`cutSha`が真のとき、副題に出す最初の版を、
 * 最初に現れた位置で切り出す。副題に同じ値を2回出さないためである。
 * ほかの対象や版と、先頭の対象と同じ文字列の一部は残す。
 */
function excerptSource(
  description: NoticeDescription,
  cutTarget: boolean,
  cutSha: boolean,
): string {
  const target = description.targets[0];
  const sha = description.shas[0];
  const { message } = description;
  const ranges: { start: number; end: number }[] = [];
  if (cutTarget && target !== undefined) {
    ranges.push({
      start: target.index,
      end: target.index + target.label.length,
    });
  }
  const shaStart = sha === undefined ? -1 : message.indexOf(sha);
  if (cutSha && sha !== undefined && shaStart >= 0) {
    ranges.push({ start: shaStart, end: shaStart + sha.length });
  }
  // 後ろから切り出し、前の範囲の位置がずれないようにする。
  const text = ranges
    .sort((a, b) => b.start - a.start)
    .reduce(
      (rest, range) => rest.slice(0, range.start) + rest.slice(range.end),
      message,
    );
  return description.shas
    .reduce(
      (shortened, each) => shortened.split(each).join(shortSha(each)),
      text,
    )
    .replace(/\s+/g, " ")
    .trim();
}

function commonPrefixLength(
  a: readonly string[],
  b: readonly string[],
): number {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) {
    length += 1;
  }
  return length;
}

/** コードポイントの並びの辞書順。 */
function compareChars(a: readonly string[], b: readonly string[]): number {
  const shared = commonPrefixLength(a, b);
  const left = a[shared];
  const right = b[shared];
  if (left === undefined || right === undefined) {
    return a.length - b.length;
  }
  return left < right ? -1 : 1;
}

/**
 * 同じ種類の通知それぞれについて、ほかの通知と本文が食い違う位置(共通する先頭の文字数)を返す。
 * 辞書順に並べると、最も長く先頭が重なる通知は隣にあるので、隣とだけ比べる。
 * 本文が同じ通知は、見分けようがないので比べない。
 */
function divergences(sources: readonly string[]): Map<string, number> {
  const distinct = [...new Set(sources)].map((text) => ({
    text,
    chars: Array.from(text),
  }));
  distinct.sort((a, b) => compareChars(a.chars, b.chars));
  return new Map(
    distinct.map((entry, index) => {
      const previous = distinct[index - 1];
      const next = distinct[index + 1];
      return [
        entry.text,
        Math.max(
          previous === undefined
            ? 0
            : commonPrefixLength(entry.chars, previous.chars),
          next === undefined ? 0 : commonPrefixLength(entry.chars, next.chars),
        ),
      ];
    }),
  );
}

/** 語の区切りになる文字。抜粋が語の途中から始まらないようにする。 */
const WORD_BOUNDARY = /[\s(「、。:/_]/u;

/**
 * 本文の抜粋を1行で返す。`divergence`は、同じ種類のほかの通知と食い違う位置で、そこから少し手前を出す。
 * 同じ種類の通知は書き出しがそろうので、先頭だけでは見分けられないためである。
 * 手前の範囲に語の区切りがあれば、その直後から始める。開始位置は食い違う位置を越えない。
 * 前後が省かれたときは省略記号を付ける。
 */
function excerpt(text: string, divergence: number): string {
  const chars = Array.from(text);
  const lead = Math.max(0, divergence - EXCERPT_LEAD);
  const boundary =
    lead === 0
      ? -1
      : chars.slice(lead, divergence).findIndex((c) => WORD_BOUNDARY.test(c));
  const start = boundary === -1 ? lead : lead + boundary + 1;
  const end = start + EXCERPT_LENGTH;
  return [
    start > 0 ? "…" : "",
    chars.slice(start, end).join("").trim(),
    end < chars.length ? "…" : "",
  ].join("");
}

/** 値が全員で同じか。1件だけのときは、比べる相手がいないので偽にする。 */
function allShare(values: readonly (string | undefined)[]): boolean {
  return values.length > 1 && new Set(values).size === 1;
}

/**
 * 同じ種類の通知の副題を作る。副題は、対象、版、本文の抜粋を「・」でつなぐ。
 * 対象と版は、同じ種類の通知の間で違うときだけ出す。全員が同じ値なら見分ける役に立たず、
 * 狭い一覧では抜粋の食い違いを押し出すので省く。通知が1件だけのときは、本文にあれば出す。
 * 本文が空でなければ、副題は空にならない。
 */
function groupTexts(group: readonly NoticeEntry[]): [number, NoticeRowText][] {
  const showTarget = !allShare(
    group.map((e) => e.description.targets[0]?.label),
  );
  const showSha = !allShare(group.map((e) => e.description.shas[0]));
  const sources = group.map((e) =>
    excerptSource(e.description, showTarget, showSha),
  );
  const positions = divergences(sources);
  return group.map((entry, index): [number, NoticeRowText] => {
    const { description } = entry;
    const target = description.targets[0];
    const sha = description.shas[0];
    const source = sources[index] ?? "";
    const parts = [
      ...(!showTarget || target === undefined ? [] : [target.label]),
      ...(!showSha || sha === undefined ? [] : [`版 ${shortSha(sha)}`]),
      ...(source === "" ? [] : [excerpt(source, positions.get(source) ?? 0)]),
    ];
    const full = shortenedMessage(description);
    return [
      entry.notice.notice_id,
      {
        subLabel: parts.length === 0 ? null : parts.join("・"),
        subTitle: full === "" ? null : full,
      },
    ];
  });
}

/** 一覧ごとに通知の副題を1回だけ作るための記憶。一覧の配列が同じなら、行ごとに作り直さない。 */
const NOTICE_TEXTS = new WeakMap<
  readonly InboxItem[],
  ReadonlyMap<number, NoticeRowText>
>();

function noticeRowTexts(
  items: readonly InboxItem[],
): ReadonlyMap<number, NoticeRowText> {
  const cached = NOTICE_TEXTS.get(items);
  if (cached !== undefined) {
    return cached;
  }
  const groups = new Map<string, NoticeEntry[]>();
  for (const item of items) {
    if (item.type === "notice") {
      const entries = groups.get(item.notice.kind) ?? [];
      entries.push({
        notice: item.notice,
        description: describeNotice(item.notice),
      });
      groups.set(item.notice.kind, entries);
    }
  }
  const texts = new Map(
    [...groups.values()].flatMap((group) => groupTexts(group)),
  );
  NOTICE_TEXTS.set(items, texts);
  return texts;
}

export type RowOptions = {
  /** 通知と失敗の固定の種別の語を出すか。既定は出す。 */
  readonly showKind?: boolean;
  /** 同じ一覧の項目。通知の副題が、同じ種類の通知と見分けられるようにするために使う。 */
  readonly peers?: readonly InboxItem[];
};

/**
 * 一覧の1行に出す内容。期限は`nowMs`からの残りで決める。種類ごとの違いはここに閉じ込め、行の部品は種類を知らずに描く。
 * `options.showKind`が偽のとき、通知と失敗の固定の種別の語を省く。承認の種別の語は省かない。
 */
export function describeRow(
  item: InboxItem,
  nowMs: number,
  options: RowOptions = {},
): RowDescription {
  const { showKind = true, peers = [] } = options;
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
        subTitle: null,
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
        kindLabel: showKind ? "失敗" : null,
        statusLabel: workItemStatusLabel(item.failure.status),
        subLabel: `${workItemKindLabel(item.failure.kind)}・${workItemRef(item.failure.work_item_id)}`,
        subTitle: null,
        iso: item.failure.updated_at,
        expiry: null,
      };
    case "notice": {
      const description = describeNotice(item.notice);
      const texts =
        noticeRowTexts(peers).get(item.notice.notice_id) ??
        noticeRowTexts([item]).get(item.notice.notice_id);
      return {
        key,
        title: description.title,
        kindLabel: showKind ? "通知" : null,
        statusLabel: description.resolved ? "解決済み" : null,
        subLabel: texts?.subLabel ?? null,
        subTitle: texts?.subTitle ?? null,
        iso: item.notice.created_at,
        expiry: null,
      };
    }
  }
}

export type UnlistedCount = {
  readonly type: InboxKind;
  readonly label: string;
  readonly count: number;
  /** 取得の上限を超えた分ではなく、一覧に載せない理由があるときの理由。 */
  readonly cause?: "audit";
};

/**
 * 一覧に出ていない件数のカードに添える文。
 * 失敗の残りは、監査の失敗(再実行できない)と、取得の上限を超えた分である。
 * 承認と通知の残りは、取得の上限を超えた分である。
 * 取得は新しい順に上限まで読むので、超えた分は古いものから見えない。
 * 古い失敗に、再実行できるものが含まれることもある。
 */
export function unlistedNote(entry: UnlistedCount): string {
  if (entry.cause === "audit") {
    return "再実行できません。システムの画面で確認してください";
  }
  switch (entry.type) {
    case "approval":
      return "取得の上限を超えた分は、依頼の古いものから表示されません";
    case "notice":
      return "取得の上限を超えた分は、発生の古いものから表示されません";
    case "failure":
      return "取得の上限を超えた分は、更新の古いものから表示されません";
  }
}

/**
 * 一覧に出ていない件数から、続きを見る画面のパス。
 * システムの画面が読めるのは、再実行できない監査の失敗だけである。
 * 取得の上限を超えた承認、失敗、通知は、その画面に載らないので`null`にする。
 */
export function unlistedPath(entry: UnlistedCount): string | null {
  return entry.cause === "audit" ? SYSTEM_PATH : null;
}

/**
 * 一覧に出ていない要対応の件数を、種類ごとに返す。無ければ空の配列。
 * 件数(`counts`)は取得の上限を超えた分も数える。種類ごとに、件数から一覧にある項目を引いた差を返す。
 * 承認、失敗、通知とも、一覧にない分は取得の上限を超えた分である(監査の失敗は別に数える)。
 */
export function unlistedCounts(
  counts: SummaryCounts,
  items: readonly InboxItem[],
  auditFailures = 0,
  _auditFailuresOpen: number = auditFailures,
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
      count: counts.failures - auditFailures - listed.failure,
    },
    {
      type: "failure",
      label: "監査の失敗",
      count: auditFailures,
      cause: "audit",
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
