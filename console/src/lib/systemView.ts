// システムの画面が出す内容を決める純関数。
// 画面は生のコードや英語のフィールド名を出さず、この結果だけを描く。
// 通知の本文や失敗の内容には、Issueや実行の出力に由来する文字が混じる。隠れた文字を置き換えて、プレーンテキストとして返す。

import type { SummaryFailure, SummaryNotice } from "../api/guards/summary.ts";
import type {
  SystemDeployment,
  SystemFetcher,
  SystemOrphanFailure,
  SystemResolvedNotice,
} from "../api/guards/systemStatus.ts";
import { withSelection } from "./inboxSelection.ts";
import { displayableIssueText } from "./intakeText.ts";
import { isJobId } from "./jobLink.ts";
import {
  deploymentResultLabel,
  hostActionLabel,
  noticeKindLabel,
} from "./labels.ts";
import { shortSha, versionText } from "./updateHistory.ts";

export type Tone = "success" | "warning" | "failure";

/** 情報の通知と作業項目に紐づかない失敗を出す期間(日)。`console_support`の`INFO_NOTICE_WINDOW_DAYS`に合わせる。 */
export const SYSTEM_WINDOW_DAYS = 7;

/**
 * summaryとsystem_statusが本文や失敗の文を切る文字数(コードポイント)。
 * `console_query`の`SUMMARY_TEXT_LIMIT`に合わせる。この長さに達した文は切られている可能性がある。
 */
export const SYSTEM_TEXT_LIMIT = 500;

/** 一覧の1行に出す本文の長さ(文字数)。全文は開いて読む。 */
export const PREVIEW_LENGTH = 120;

/**
 * 一覧が上限の件数に達したときの注記。達していなければ`null`。
 * 件数がちょうど上限のときも、古いものが無いとは言い切れない。
 */
export function listLimitNote(count: number, limit: number): string | null {
  return count >= limit
    ? `${String(limit)}件に達したので、これより古いものは表示していない場合があります。`
    : null;
}

export type FetcherDescription = {
  readonly tone: Tone;
  /** 状態の短い日本語。 */
  readonly label: string;
  /** 状態の補足。無ければ`null`。 */
  readonly detail: string | null;
  /** 取り込んだ版の短い形。分からなければ`null`。 */
  readonly versionLabel: string | null;
  /** 最後に確かめた時刻(ISO文字列)。状態を読めないときは`null`。 */
  readonly checkedAt: string | null;
  /** 取り込みが記録した失敗の分類。無ければ`null`。 */
  readonly errorCode: string | null;
  /** 運用者の次の操作。無ければ`null`。 */
  readonly nextAction: string | null;
};

const FETCHER_STATE_LABELS: ReadonlyMap<string, string> = new Map([
  ["ok", "取り込み済み"],
  ["failed", "取り込みに失敗"],
  ["pinned", "版を固定中"],
]);

const UNKNOWN_FETCHER_LABEL = "不明な状態";

const UNAVAILABLE_DETAILS: ReadonlyMap<string, string> = new Map([
  ["missing", "取り込みの状態のファイルがありません。"],
  ["invalid", "取り込みの状態のファイルの形式が正しくありません。"],
]);

const STALE_DETAIL = "30分以上、取り込みの結果が更新されていません。";

function fetcherTone(state: string, assessment: string): Tone {
  if (assessment === "failed") {
    return "failure";
  }
  if (assessment === "ok") {
    return state === "failed"
      ? "failure"
      : state === "pinned"
        ? "warning"
        : "success";
  }
  return "warning";
}

/** Consoleの取り込みの状態を、画面に出す内容にする。 */
export function describeFetcher(fetcher: SystemFetcher): FetcherDescription {
  if (fetcher.availability === "unavailable") {
    return {
      tone: "warning",
      label: "状態を読めません",
      detail:
        UNAVAILABLE_DETAILS.get(fetcher.reason) ??
        "取り込みの状態を読めません。",
      versionLabel: null,
      checkedAt: null,
      errorCode: null,
      nextAction: null,
    };
  }
  return {
    tone: fetcherTone(fetcher.state, fetcher.assessment),
    label: FETCHER_STATE_LABELS.get(fetcher.state) ?? UNKNOWN_FETCHER_LABEL,
    detail: fetcher.assessment === "stale" ? STALE_DETAIL : null,
    versionLabel: fetcher.sha === null ? null : shortSha(fetcher.sha),
    checkedAt: fetcher.checked_at,
    errorCode:
      fetcher.error === null ? null : displayableIssueText(fetcher.error).text,
    nextAction:
      fetcher.next_action === null
        ? null
        : displayableIssueText(fetcher.next_action).text,
  };
}

export type DeploymentDescription = {
  readonly versionLabel: string;
  readonly resultLabel: string;
  readonly resultTone: Tone;
  readonly hostActionLabel: string;
  readonly hostActionTone: "warning" | "neutral";
  readonly changedPathCount: number;
  readonly occurredAt: string;
};

/** 直近の反映を、画面に出す内容にする。 */
export function describeLatestDeployment(
  deployment: SystemDeployment,
): DeploymentDescription {
  return {
    versionLabel: versionText(deployment.sha_from, deployment.sha_to),
    resultLabel: deploymentResultLabel(deployment.result),
    resultTone: deployment.result === "success" ? "success" : "failure",
    hostActionLabel: hostActionLabel(deployment.needs_host_action),
    hostActionTone: deployment.needs_host_action ? "warning" : "neutral",
    changedPathCount: deployment.changed_paths.length,
    occurredAt: deployment.occurred_at,
  };
}

/** 要対応の画面で通知を選んだ経路。routerの基準(`/console`)からの絶対パスで書く。 */
export function noticeDetailPath(noticeId: number): string {
  const params = withSelection(new URLSearchParams(), {
    type: "notice",
    id: noticeId,
  });
  return `/?${params.toString()}`;
}

/**
 * 本文の最初の空でない行を、`max`文字(コードポイント)までにして返す。
 * 切ったときは末尾に「…」を付ける。
 */
export function messagePreview(message: string, max: number): string {
  const line =
    message.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  const characters = [...line.trim()];
  return characters.length > max
    ? `${characters.slice(0, max).join("")}…`
    : characters.join("");
}

export type InfoNoticeDescription = {
  readonly noticeId: number;
  readonly title: string;
  readonly preview: string;
  readonly createdAt: string;
  /** 要対応の画面での詳細への経路。 */
  readonly href: string;
  /** 詳細からConsoleで解決できる種類か。 */
  readonly canResolve: boolean;
};

/** 情報の通知の1行を、画面に出す内容にする。 */
export function describeInfoNotice(
  notice: SummaryNotice,
): InfoNoticeDescription {
  return {
    noticeId: notice.notice_id,
    title: noticeKindLabel(notice.kind),
    preview: messagePreview(
      displayableIssueText(notice.message).text,
      PREVIEW_LENGTH,
    ),
    createdAt: notice.created_at,
    href: noticeDetailPath(notice.notice_id),
    canResolve: notice.resolvable,
  };
}

const RESOLVER_LABELS: ReadonlyMap<string, string> = new Map([
  ["cleanup_db", "DBの掃除(自動)"],
  ["self_update", "自己更新(自動)"],
  ["poll_issues", "Issueの取得(自動)"],
]);

/**
 * 解決した主体の日本語。自動の解決は処理の名前にし、それ以外は記録された名前をそのまま文字にする。
 * 記録が無ければ「記録なし」にする。
 */
export function resolverLabel(resolvedBy: string | null): string {
  if (resolvedBy === null) {
    return "記録なし";
  }
  return (
    RESOLVER_LABELS.get(resolvedBy) ?? displayableIssueText(resolvedBy).text
  );
}

export type ResolvedNoticeDescription = {
  readonly noticeId: number;
  readonly title: string;
  readonly preview: string;
  /** 本文の全文。`SYSTEM_TEXT_LIMIT`文字で切ってある。 */
  readonly message: string;
  readonly createdAt: string;
  /** 解決した時刻(ISO文字列)。記録が無ければ`null`。 */
  readonly resolvedAt: string | null;
  readonly resolver: string;
};

/** 解決済みの通知の1行を、画面に出す内容にする。 */
export function describeResolvedNotice(
  notice: SystemResolvedNotice,
): ResolvedNoticeDescription {
  const message = displayableIssueText(notice.message).text;
  return {
    noticeId: notice.notice_id,
    title: noticeKindLabel(notice.kind),
    preview: messagePreview(message, PREVIEW_LENGTH),
    message,
    createdAt: notice.created_at,
    resolvedAt: notice.resolved_at,
    resolver: resolverLabel(notice.resolved_by),
  };
}

export type OrphanFailureDescription = {
  readonly id: number;
  /** フローと、あればステップ。 */
  readonly flowLabel: string;
  /** ジョブIDの形のものだけで、そうでなければ`null`。 */
  readonly jobId: string | null;
  readonly occurredAt: string;
  readonly error: { readonly text: string; readonly truncated: boolean };
};

/** 作業項目に紐づかない失敗の1行を、画面に出す内容にする。 */
export function describeOrphanFailure(
  failure: SystemOrphanFailure,
): OrphanFailureDescription {
  const flow = displayableIssueText(failure.flow_path).text;
  return {
    id: failure.job_failure_id,
    flowLabel:
      failure.step === null
        ? flow
        : `${flow} / ${displayableIssueText(failure.step).text}`,
    jobId: isJobId(failure.job_id) ? failure.job_id : null,
    occurredAt: failure.occurred_at,
    error: {
      text: displayableIssueText(failure.error).text,
      truncated: [...failure.error].length >= SYSTEM_TEXT_LIMIT,
    },
  };
}

/** 要対応の失敗のうち、監査のものを元の順で返す。監査は再実行できないので、要対応の一覧に出さない。 */
export function auditFailuresOf(
  failures: readonly SummaryFailure[],
): SummaryFailure[] {
  return failures.filter((failure) => failure.kind === "audit");
}
