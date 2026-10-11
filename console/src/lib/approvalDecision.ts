// 承認バーの判定と文言を決める純粋関数。
// 画面は、どの操作を出すか、何を送るか、確認ダイアログに何を書くかを、ここで決めた結果だけで描く。

import type { SummaryApproval } from "../api/guards/summary.ts";
import { MAX_REASON_LENGTH } from "../api/writes.ts";

/**
 * 承認と却下の操作を出してよい依頼か。承認待ち(pending)で、期限内のものに限る。
 * 期限は、過ぎた瞬間から操作させない。読めない期限と知らない状態は、安全側に倒して出さない。
 */
export function isDecidable(
  approval: Pick<SummaryApproval, "status" | "expires_at">,
  nowMs: number,
): boolean {
  if (approval.status !== "pending") {
    return false;
  }
  if (approval.expires_at === null) {
    return true;
  }
  const expiresMs = Date.parse(approval.expires_at);
  return !Number.isNaN(expiresMs) && expiresMs > nowMs;
}

/** 理由の文字数。上限と同じく、コードポイントで数える。 */
function reasonLength(reason: string): number {
  return [...reason].length;
}

type ReasonCounter = {
  readonly count: number;
  readonly max: number;
  readonly over: boolean;
  /** 入力欄の横に出す「120 / 4000文字」。 */
  readonly label: string;
};

/** 理由の長さと上限を、入力欄で知らせるための値にする。 */
export function reasonCounter(reason: string): ReasonCounter {
  const count = reasonLength(reason);
  return {
    count,
    max: MAX_REASON_LENGTH,
    over: count > MAX_REASON_LENGTH,
    label: `${String(count)} / ${String(MAX_REASON_LENGTH)}文字`,
  };
}

/** 却下できない理由の文。却下してよければ`null`。理由は、空白だけでも上限を超えても断る。 */
export function rejectProblem(reason: string): string | null {
  if (reason.trim().length === 0) {
    return "却下する理由を入力してください。";
  }
  if (reasonLength(reason) > MAX_REASON_LENGTH) {
    return `理由は${String(MAX_REASON_LENGTH)}文字までです。`;
  }
  return null;
}

/**
 * 取り込み時点のIssueを承認者が見られる状態か。
 * 読み込み中と取得の失敗では、承認者が内容を確かめられないので`ready`にしない。
 * 作業項目に取り込み内容が無いときは、取得が成功しているので、見るものが無いまま`ready`にする。
 */
export function snapshotReadiness(query: {
  readonly isPending: boolean;
  readonly isError: boolean;
}): "loading" | "failed" | "ready" {
  if (query.isError) {
    return "failed";
  }
  return query.isPending ? "loading" : "ready";
}

type FactoryLabelChoice = {
  /** 選択肢(チェックボックス)を出すか。 */
  readonly offered: boolean;
  /** チェックボックスの初期値。 */
  readonly initial: boolean;
};

/**
 * Issue提案の承認で、作るIssueにfactoryラベルを付けるかの選択肢。
 * 監査から出た提案は、すぐ要件定義に戻す想定なので、初期値をオンにする。
 * ラベルを付けられない監査の提案(`factory_label_available`が偽)は、選択肢を出さない。
 * PRのレビューから出た提案は、依頼者の選択に任せ、初期値をオフにする。
 */
export function factoryLabelChoice(proposal: {
  readonly origin: string;
  readonly factory_label_available: boolean;
}): FactoryLabelChoice {
  const fromAudit = proposal.origin === "audit";
  return {
    offered: !fromAudit || proposal.factory_label_available,
    initial: fromAudit,
  };
}

/**
 * `decideApproval`に渡す`withFactoryLabel`。
 * 送る形は種類で決める。Issue提案だけが持ち、選択肢を出していないときは`false`を送る。
 * 要件定義とそれ以外の種類は`undefined`にして、何も送らない。
 */
export function withFactoryLabelArg(
  kind: string,
  offered: boolean,
  checked: boolean,
): boolean | undefined {
  if (kind !== "issue_proposal") {
    return undefined;
  }
  return offered ? checked : false;
}

type ApprovalConfirmation = {
  readonly subject: string;
  readonly idLabel: string;
  readonly consequence: string;
};

/**
 * 承認の確認ダイアログの文。承認は取り消せず、要件定義ならClaudeの実装が始まる。
 * `subject`は、Issueに由来する文字を`displayableIssueText`に通したものを渡す。
 */
export function approvalConfirmation(input: {
  readonly kind: string;
  readonly subject: string;
  readonly approvalRequestId: number;
  readonly withFactoryLabel: boolean | undefined;
}): ApprovalConfirmation {
  const idLabel = `承認依頼 #${String(input.approvalRequestId)}`;
  if (input.kind === "issue_proposal") {
    const label =
      input.withFactoryLabel === true
        ? "factoryラベルを付けるので、要件定義の作成も始まります。"
        : "";
    return {
      subject: input.subject,
      idLabel,
      consequence: `承認すると、GitHubにIssueを作ります。${label}取り消せません。`,
    };
  }
  return {
    subject: input.subject,
    idLabel,
    consequence: "承認すると、Claudeによる実装が始まります。取り消せません。",
  };
}

type ApprovalLinks = {
  /** 要件定義書の経路。要件定義の承認だけが持つ。 */
  readonly requirements: string | null;
  /** 提案の元の監査レポートの経路。監査から出た提案だけが持つ。 */
  readonly auditReport: string | null;
};

/**
 * 承認の詳細から他の画面へ移る経路。routerの基準(`/console`)からの絶対パスで返す。
 * idは正の整数として検証済みの値だけを埋める。
 */
export function approvalLinks(
  approval: Pick<
    SummaryApproval,
    "kind" | "work_item_id" | "draft_attempt" | "origin"
  >,
): ApprovalLinks {
  const workItemId = String(approval.work_item_id);
  const requirementsPath = `/items/${workItemId}/requirements`;
  return {
    requirements:
      approval.kind !== "requirements"
        ? null
        : approval.draft_attempt === null
          ? requirementsPath
          : `${requirementsPath}?attempt=${String(approval.draft_attempt)}`,
    auditReport:
      approval.kind === "issue_proposal" && approval.origin === "audit"
        ? `/reports/audit/${workItemId}`
        : null,
  };
}
