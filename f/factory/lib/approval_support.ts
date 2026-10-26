// 承認待ち(`approval_requests`)を扱うスクリプト群が共有する判定ロジック。
// 入出力は行わず、単体テストのためにすべての関数を公開する。

import type { ApprovalRequest, ApprovalRequestKind } from "./types.ts";

/**
 * `requirements`の承認依頼が`pending`のまま待つ秒数(7日)。
 * これを過ぎると、`poll_issues.ts`の定期処理が期限切れにする。
 * `issue_proposal`の承認依頼は期限を持たない(`expires_at`が`null`)。
 */
export const APPROVAL_TIMEOUT_SEC = 604800;

/** 新しい`requirements`承認依頼の期限(`now`の`APPROVAL_TIMEOUT_SEC`秒後)を返す。 */
export function computeExpiresAt(now: Date): Date {
  return new Date(now.getTime() + APPROVAL_TIMEOUT_SEC * 1000);
}

/**
 * `factory.approval_requests`の行が、`pending`のまま期限を過ぎているかを返す。
 * `poll_issues.ts`の期限切れ処理が使う判定である。
 * `expires_at`が`null`の行(`issue_proposal`など)は期限切れにならない。
 */
export function isExpired(
  request: Pick<ApprovalRequest, "status" | "expires_at">,
  now: Date,
): boolean {
  return (
    request.status === "pending" &&
    request.expires_at !== null &&
    request.expires_at.getTime() <= now.getTime()
  );
}

export type ExistingDecisionAction =
  | "record_and_dispatch"
  | "redispatch"
  | "refuse";

/**
 * `approval_decide.ts`が読んだ承認依頼の行に対して、
 * 今回記録しようとしている判断をどう扱うかを決める。
 * - `"record_and_dispatch"`: 行がまだ`pending`である。
 *   判断を記録し、種類ごとのapplyスクリプトへ渡す。
 * - `"redispatch"`: 行に同じ判断がすでに記録されている。
 *   判断の記録後にapplyスクリプトへの受け渡しが失敗したときの再試行などで、
 *   冪等に扱うため、記録はし直さずに受け渡しだけ行う。
 * - `"refuse"`: 行に異なる判断が記録されている(本当の競合)か、期限切れである。
 *   何もせず、呼び出し側が例外を投げる。
 */
export function classifyExistingDecision(
  existingStatus: string,
  requestedStatus: "approved" | "rejected",
): ExistingDecisionAction {
  if (existingStatus === "pending") {
    return "record_and_dispatch";
  }
  return existingStatus === requestedStatus ? "redispatch" : "refuse";
}

/**
 * 呼び出し側が渡した`note`を、記録する`reason`にまとめる。
 * どちらも空なら`null`を返す。
 */
export function buildRecordedReason(
  reason: string,
  note: string,
): string | null {
  const parts: string[] = [];
  const trimmedReason = reason.trim();
  if (trimmedReason.length > 0) {
    parts.push(trimmedReason);
  }
  const trimmedNote = note.trim();
  if (trimmedNote.length > 0) {
    parts.push(`(caller note: ${trimmedNote})`);
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

/**
 * Consoleの入口のパス。承認フローのscriptはすべてここからConsoleへのリンクを作る。
 * 末尾の`/`を含める。Caddyは`/console/`の下だけをConsoleのSPAとして配るため。
 */
const CONSOLE_ENTRANCE_PATH = "/console/";

/**
 * ConsoleのURLを返す。このURLはログインを求める。
 * 承認・却下を求めるときに投稿するリンクは、ログインを求めるConsoleのURLだけにする。
 * `getResumeUrls()`の署名付きURLは、見た人が承認の記録を残さずに止まったフローを再開できるため載せない。
 *
 * `target`を渡すと、その作業項目の要件定義書のページ
 * (`/console/items/<work_item_id>/requirements`)を指す。
 * `target.attempt`があるとその試行の要件定義書を、無ければ最新の試行を開く。
 * 経路の形は`console/src/app/screens.ts`の表に合わせる。
 */
export function buildConsoleUrl(
  windmillPublicUrl: string,
  target?: { work_item_id: number; attempt?: number },
): string {
  const entrance = `${windmillPublicUrl}${CONSOLE_ENTRANCE_PATH}`;
  if (target === undefined) {
    return entrance;
  }
  const page = `${entrance}items/${String(target.work_item_id)}/requirements`;
  return target.attempt === undefined
    ? page
    : `${page}?attempt=${String(target.attempt)}`;
}

/**
 * 承認依頼1件を選んだ状態のConsoleの要対応のURL(`/console/?approval=<id>`)を返す。
 * 承認と却下はこの画面で行う。
 */
export function buildApprovalConsoleUrl(
  windmillPublicUrl: string,
  approvalRequestId: number,
): string {
  return `${windmillPublicUrl}${CONSOLE_ENTRANCE_PATH}?approval=${String(approvalRequestId)}`;
}

/** noticeを1件選んだ状態のConsoleの要対応のURL(`/console/?notice=<id>`)を返す。 */
export function buildNoticeConsoleUrl(
  windmillPublicUrl: string,
  noticeId: number,
): string {
  return `${windmillPublicUrl}${CONSOLE_ENTRANCE_PATH}?notice=${String(noticeId)}`;
}

/** 監査レポート1件を開くConsoleのURL(`/console/reports/audit/<work_item_id>`)を返す。 */
export function buildAuditConsoleUrl(
  windmillPublicUrl: string,
  workItemId: number,
): string {
  return `${windmillPublicUrl}${CONSOLE_ENTRANCE_PATH}reports/audit/${String(workItemId)}`;
}

/**
 * Consoleの作業項目の画面のURL(`/console/items`)を返す。
 * 画面は既定で進行中の作業項目だけを出す。
 * 終わった状態の作業項目を指す案内には、`scope: "all"`を渡して、すべてを開くURL(`?scope=all`)にする。
 */
export function buildItemsConsoleUrl(
  windmillPublicUrl: string,
  options: { readonly scope?: "all" } = {},
): string {
  const base = `${windmillPublicUrl}${CONSOLE_ENTRANCE_PATH}items`;
  return options.scope === undefined ? base : `${base}?scope=${options.scope}`;
}

/** Consoleのシステムの画面のURL(`/console/system`)を返す。 */
export function buildSystemConsoleUrl(windmillPublicUrl: string): string {
  return `${windmillPublicUrl}${CONSOLE_ENTRANCE_PATH}system`;
}

/**
 * 判断が記録された承認依頼を処理するstepスクリプトのパスを、種類ごとに返す。
 * `approval_decide.ts`は判断を記録した後、
 * `wmill.runScriptByPathAsync`でこのパスのスクリプトを起動する。
 * `design`にはハンドラーがまだ無いので例外を投げる。
 */
export function handlerPathFor(kind: ApprovalRequestKind): string {
  switch (kind) {
    case "requirements":
      return "f/factory/steps/requirements_apply";
    case "issue_proposal":
      return "f/factory/steps/issue_proposal_apply";
    case "design":
      throw new Error("approval_support: no approval handler for kind design");
  }
}

/**
 * 承認依頼の一覧から`requirements`の種類だけを取り出す。
 * `poll_issues.ts`の期限切れ処理では、状態の移行やラベルの片付けといった
 * `requirements`固有の副作用をこの部分集合にだけ適用する。
 * `issue_proposal`は`expires_at`を持たないので、そもそも期限切れの一覧に入らない。
 * それでも種類ごとの分岐を、DB側のこの保証とは別にテストできるよう関数にしている。
 */
export function expiredRequirementsRequests<
  T extends { kind: ApprovalRequestKind },
>(requests: readonly T[]): T[] {
  return requests.filter((request) => request.kind === "requirements");
}

/**
 * Issueの確認の結果。
 * - `match`: 現在のIssueの題名と本文が取り込み時点と同じ。
 * - `changed`: 取り込み後に題名か本文が変わった。
 * - `not_applicable`: 承認の対象がIssueに基づく要件定義ではない。
 * - `unavailable`: GitHubから取得できないなどで、比べられなかった。
 */
export type IssueCheckVerdict =
  | "match"
  | "changed"
  | "not_applicable"
  | "unavailable";

/**
 * 決定を記録する前に、Issueを取り込み時点と比べる必要があるかを返す。副作用は無い。
 * 比べるのは、要件定義を承認し、これから決定を記録するときだけである。
 * 却下は実装に渡る内容を決めない。
 * 記録済みの決定の再実行(`redispatch`)は、記録のときに確認を済ませている。
 * Issue提案には取り込み時点の内容が無い。
 */
export function needsIssueCheck(
  action: ExistingDecisionAction,
  decision: "approve" | "reject",
  kind: ApprovalRequestKind,
): boolean {
  return (
    action === "record_and_dispatch" &&
    decision === "approve" &&
    kind === "requirements"
  );
}

/**
 * Issueの確認の判定から、承認を断る理由を返す。承認してよいときはnullを返す。
 * 承認者が見た取り込み時点の内容と、実装のClaudeが受け取る内容を一致させるため、
 * 比べられなかったときも断る(安全側)。
 * 現在のIssueの内容を使うには、却下する。却下による作り直しは、現在のIssueの内容を取り込み直す。
 */
export function issueCheckRefusal(
  verdict: IssueCheckVerdict,
  approvalRequestId: number,
): string | null {
  switch (verdict) {
    case "match":
    case "not_applicable":
      return null;
    case "changed":
      return [
        `approval_decide: the issue title or body changed after intake, so approval request ${String(approvalRequestId)} was not approved.`,
        "Claude implements the content captured at intake, which the Inbox of the new Console (/console/) shows.",
        "To approve it, restore the issue to that content and approve again.",
        "To use the current issue instead, reject the request; the requirements are regenerated from the current issue and need a new approval.",
      ].join(" ");
    case "unavailable":
      return `approval_decide: the issue could not be compared with the intake content, so approval request ${String(approvalRequestId)} was not approved. Wait a moment and try again. If the issue was transferred or deleted, reject the request.`;
  }
}
