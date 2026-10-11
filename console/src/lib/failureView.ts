// 要対応の失敗について、詳細のペインと再実行の確認に出す内容を決める純粋関数。
// 画面は生のコードや英語のフィールド名を出さず、この結果だけを描く。

import type { SummaryFailure } from "../api/guards/summary.ts";
import { displayableIssueText } from "./intakeText.ts";
import { isJobId } from "./jobLink.ts";
import {
  workItemKindLabel,
  workItemRef,
  workItemStatusLabel,
} from "./labels.ts";
import { safeGitHubUrl } from "./safeUrl.ts";

/**
 * summaryが失敗の文を切る長さ(文字数)。`console_query`の`SUMMARY_TEXT_LIMIT`に合わせる。
 * この長さに達した文は切られている可能性があるので、画面で全文ではないと知らせる。
 */
export const FAILURE_TEXT_LIMIT = 500;

/** 作業項目の詳細の経路。routerの基準(`/console`)からの絶対パスで書く。 */
export function workItemPath(workItemId: number): string {
  return `/items/${workItemId}`;
}

/**
 * 失敗の記録と、今の状態へ遷移した時刻の許容する差(ミリ秒)。
 * 失敗の処理は、記録を書いてから状態を更新するので、正常な記録も状態の時刻より少し前になる。
 * この差より前の記録は、今の状態になる前のものとみなす。
 */
const RECORD_SKEW_MS = 5 * 60 * 1000;

/**
 * 失敗の記録の状態。
 * `missing`は記録が無い。`predates_status`は、記録が今の状態になる前のもので、
 * 前の失敗の記録を今の失敗と取り違えないよう、内容として扱わない。
 */
export type FailureRecordState = "current" | "missing" | "predates_status";

export type FailureDescription = {
  readonly title: string;
  readonly kindLabel: string;
  readonly statusLabel: string;
  /** 失敗(`failed`)は失敗の色、人の対応待ちと期限切れは警告の色にする。 */
  readonly statusTone: "failure" | "warning";
  readonly workItemLabel: string;
  readonly repoLabel: string;
  /** 「Issue #9」や「PR #12」。対象の番号が無い作業項目(監査など)では`null`。 */
  readonly targetLabel: string | null;
  /** リンクにしてよい対象のURL。GitHubのIssueかPRのURLの形でなければ`null`。 */
  readonly targetUrl: string | null;
  readonly recordState: FailureRecordState;
  /** `occurredAt`の見出し。今の失敗の記録があれば「失敗した時刻」、無ければ「状態が変わった時刻」。 */
  readonly occurredLabel: string;
  /** 失敗の記録のフローとステップ。今の失敗の記録が無ければ`null`。 */
  readonly flowLabel: string | null;
  /** 失敗の記録のジョブID。ジョブIDの形のものだけで、そうでなければ`null`。 */
  readonly jobId: string | null;
  /** 失敗の時刻(ISO文字列)。今の失敗の記録が無ければ状態が変わった時刻、それも無ければ最後の更新の時刻。 */
  readonly occurredAt: string;
  /** 作業項目の最終更新の時刻(ISO文字列)。一覧はこの時刻の新しい順に並ぶ。 */
  readonly updatedAt: string;
  /** 失敗の記録の文。今の失敗の記録が無ければ`null`。 */
  readonly error: { readonly text: string; readonly truncated: boolean } | null;
  /** 今の状態へ遷移したときの注記。 */
  readonly statusNote: string | null;
};

const PR_KINDS: ReadonlySet<string> = new Set(["pr_review", "pr_fix"]);

type Target = { readonly label: string; readonly url: string | null };

function issueTarget(failure: SummaryFailure): Target | null {
  return failure.issue_number === null
    ? null
    : {
        label: `Issue #${failure.issue_number}`,
        url: safeGitHubUrl(failure.issue_url),
      };
}

function pullTarget(failure: SummaryFailure): Target | null {
  return failure.pr_number === null
    ? null
    : {
        label: `PR #${failure.pr_number}`,
        // DBの値を使う前に、GitHubのPRのURLの形かを`safeGitHubUrl`で確かめる。
        url: safeGitHubUrl(
          `https://github.com/${failure.owner}/${failure.repo}/pull/${failure.pr_number}`,
        ),
      };
}

/** PRの作業項目はPR、それ以外はIssueを先に見る。先の番号が無ければもう一方を使う。 */
function targetOf(failure: SummaryFailure): Target | null {
  return PR_KINDS.has(failure.kind)
    ? (pullTarget(failure) ?? issueTarget(failure))
    : (issueTarget(failure) ?? pullTarget(failure));
}

function describeError(error: string | null): FailureDescription["error"] {
  if (error === null) {
    return null;
  }
  // 切られたかは、改行の正規化や文字の置き換えの前の、受け取った文の長さで決める。
  return {
    text: displayableIssueText(error).text,
    truncated: [...error].length >= FAILURE_TEXT_LIMIT,
  };
}

function recordStateOf(failure: SummaryFailure): FailureRecordState {
  if (failure.job_failure_id === null || failure.occurred_at === null) {
    return "missing";
  }
  if (failure.status_changed_at === null) {
    return "current";
  }
  const recorded = Date.parse(failure.occurred_at);
  const changed = Date.parse(failure.status_changed_at);
  return Number.isNaN(recorded) ||
    Number.isNaN(changed) ||
    recorded >= changed - RECORD_SKEW_MS
    ? "current"
    : "predates_status";
}

/**
 * 失敗の1行を、詳細のペインに出す内容にする。起票者や実行ログに由来する文字は、隠れた文字を置き換える。
 * 今の状態になる前の失敗の記録は、内容と時刻に使わない。
 */
export function describeFailure(failure: SummaryFailure): FailureDescription {
  const target = targetOf(failure);
  const recordState = recordStateOf(failure);
  const record = recordState === "current";
  return {
    title: displayableIssueText(
      failure.title ?? workItemRef(failure.work_item_id),
    ).text,
    kindLabel: workItemKindLabel(failure.kind),
    statusLabel: workItemStatusLabel(failure.status),
    statusTone: failure.status === "failed" ? "failure" : "warning",
    workItemLabel: workItemRef(failure.work_item_id),
    repoLabel: `${failure.owner}/${failure.repo}`,
    targetLabel: target?.label ?? null,
    targetUrl: target?.url ?? null,
    recordState,
    occurredLabel: record ? "失敗した時刻" : "状態が変わった時刻",
    flowLabel:
      !record || failure.flow_path === null
        ? null
        : failure.step === null
          ? failure.flow_path
          : `${failure.flow_path} / ${failure.step}`,
    jobId: record && isJobId(failure.job_id) ? failure.job_id : null,
    occurredAt:
      (record ? failure.occurred_at : null) ??
      failure.status_changed_at ??
      failure.updated_at,
    updatedAt: failure.updated_at,
    error: record ? describeError(failure.error) : null,
    statusNote:
      failure.status_note === null
        ? null
        : displayableIssueText(failure.status_note).text,
  };
}

export type RetryPlan = {
  /** 今の状態。 */
  readonly fromLabel: string;
  /** 再開先の状態。Issueは、承認済みの要件定義の有無でscriptが決めるので、2つの候補を並べる。 */
  readonly toLabel: string;
  readonly note: string | null;
  /** 再実行できない理由。再実行できるときは`null`。 */
  readonly blockedReason: string | null;
};

const ISSUE_RESTART_NOTE =
  "承認済みの要件定義があれば実装から、なければ要件定義の作り直しから始めます。要件定義を作り直す場合は、GitHubの現在のIssueの題名と本文を取り込み直します。";

/**
 * scriptが再実行を断る場合。確認の画面で事前に伝える。
 * 断りは、ジョブの失敗として返る。画面は、断りと、途中まで進んだ失敗を区別できない。
 * `f/factory/retry_work_item.ts`の断りに合わせる。
 */
export const RETRY_REFUSALS: readonly string[] = [
  "記録されたフローがまだ動いている、または動いているか読めないとき",
  "同じIssueに、より新しいサイクルがあるとき",
  "要件定義が承認済みで、実装が無効のとき(実装を有効にすると再実行できます)",
  "確認から更新までの間に、作業項目の状態が変わったとき",
];

/**
 * 再実行の確認に出す、状態の遷移の説明。
 * 再開先はscriptが作業項目の種類で決める(`computeRestartPlan`)。
 * 画面は種類から導けるものだけを示し、知らない種類は再開先を決めつけない。
 * 知らない種類でも押せるようにして、断るかどうかはscriptに任せる。
 */
export function describeRetryPlan(failure: SummaryFailure): RetryPlan {
  const fromLabel = workItemStatusLabel(failure.status);
  switch (failure.kind) {
    case "issue":
      return {
        fromLabel,
        toLabel: "要件定義の生成中、または実装中",
        note: ISSUE_RESTART_NOTE,
        blockedReason: null,
      };
    case "pr_review":
      return {
        fromLabel,
        toLabel: workItemStatusLabel("reviewing"),
        note: null,
        blockedReason: null,
      };
    case "pr_fix":
      return {
        fromLabel,
        toLabel: workItemStatusLabel("fixing"),
        note: null,
        blockedReason: null,
      };
    case "audit":
      return {
        fromLabel,
        toLabel: "",
        note: null,
        blockedReason:
          "監査は再実行できません。次の定期の監査が、失敗した期間を扱います。",
      };
    default:
      return {
        fromLabel,
        toLabel: "作業項目の種類に応じた状態",
        note: null,
        blockedReason: null,
      };
  }
}
