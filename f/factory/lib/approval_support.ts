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
 * Factory ConsoleのWindmill Appのパス。
 * 承認フローのスクリプトはすべてこの定数からConsoleへのリンクを作る。
 * 実際のURLを確かめて直す必要が出たときに、1行の変更で済むよう1箇所にまとめている。
 */
const FACTORY_CONSOLE_APP_PATH = "f/factory/factory_console";

/**
 * Factory Console AppのInboxのURLを返す。このURLはログインを求める。
 * 承認・却下を求めるときに投稿するリンクはこれだけで、
 * 漏れると困るsuspendの権限付きURLはもう存在しない。
 *
 * `target.work_item_id`を渡すと`#requirements/<id>`のフラグメントを付け、
 * Consoleの要件定義タブがその作業項目の要件定義書を直接開けるようにする
 * (raw appの`lib/deepLink.ts`を参照)。
 * ただし、raw appは親フレームのURLを読めない場合があるため、これは保証ではない。
 * 手で辿れるよう、呼び出し側はどれもURLと一緒に`work_item_id`も書き出す
 * (IssueのコメントやDiscordのフィールド)。
 */
export function buildConsoleUrl(
  windmillPublicUrl: string,
  target?: { work_item_id: number },
): string {
  const base = `${windmillPublicUrl}/apps/get/${FACTORY_CONSOLE_APP_PATH}`;
  return target === undefined
    ? base
    : `${base}#requirements/${String(target.work_item_id)}`;
}

/** 監査レポート1件を開くConsoleのURL(監査タブ、`#audit/<work_item_id>`)を返す。 */
export function buildAuditConsoleUrl(
  windmillPublicUrl: string,
  workItemId: number,
): string {
  return `${windmillPublicUrl}/apps/get/${FACTORY_CONSOLE_APP_PATH}#audit/${String(workItemId)}`;
}

/**
 * 判断が記録された承認依頼を処理するstepスクリプトのパスを、種類ごとに返す。
 * `approval_decide.ts`は判断を記録した後、
 * `wmill.runScriptByPathAsync`でこのパスのスクリプトを起動する。
 */
export function handlerPathFor(kind: ApprovalRequestKind): string {
  switch (kind) {
    case "requirements":
      return "f/factory/steps/requirements_apply";
    case "issue_proposal":
      return "f/factory/steps/issue_proposal_apply";
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
