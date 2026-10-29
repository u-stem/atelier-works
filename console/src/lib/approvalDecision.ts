// 承認バーの判定と文言を決める純粋関数。
// 画面は、どの操作を出すか、何を送るか、確認ダイアログに何を書くかを、ここで決めた結果だけで描く。

import type { SummaryApproval } from "../api/guards/summary.ts";
import { MAX_REASON_LENGTH } from "../api/writes.ts";
import { auditReportPath } from "./auditView.ts";
import { displayableIssueText } from "./intakeText.ts";
import { requirementsPath } from "./requirementsView.ts";
import type { DesignApprovalInput } from "./visibleText.ts";

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
 * 作業項目に取り込み内容が無いとき(`data`が`null`)は`empty`にする。確かめる内容が無いまま承認させない。
 */
export function snapshotReadiness(query: {
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly data: unknown;
}): "loading" | "failed" | "empty" | "ready" {
  if (query.isError) {
    return "failed";
  }
  if (query.isPending) {
    return "loading";
  }
  return query.data === null ? "empty" : "ready";
}

export type DocReadiness =
  | "unidentified"
  | "failed"
  | "loading"
  | "missing"
  | "mismatch"
  | "ready";

/**
 * 承認する試行の要件定義書を、承認者が見られる状態か。
 * 承認の試行が分からないとき(`expectedAttempt`が`null`)は、最新の試行で代えず、`unidentified`にする。
 * 最新の試行は、承認する試行と違うことがあるためである。
 * 取得した書の試行が承認の試行と違うときは、`mismatch`にして、別の試行を見たまま承認させない。
 */
export function docReadiness(input: {
  readonly expectedAttempt: number | null;
  readonly query: {
    readonly isPending: boolean;
    readonly isError: boolean;
    readonly data: { readonly attempt: number } | null | undefined;
  };
}): DocReadiness {
  if (input.expectedAttempt === null) {
    return "unidentified";
  }
  if (input.query.isError) {
    return "failed";
  }
  if (input.query.isPending) {
    return "loading";
  }
  if (input.query.data === null || input.query.data === undefined) {
    return "missing";
  }
  return input.query.data.attempt === input.expectedAttempt
    ? "ready"
    : "mismatch";
}

const SNAPSHOT_BLOCKED = {
  loading:
    "取り込み時点のIssueを読み込み中です。表示されるまで承認できません。",
  failed:
    "取り込み時点のIssueを取得できていません。取得し直して内容を確かめるまで承認できません。",
  empty:
    "この作業項目に、取り込み時点のIssueがありません。確かめる内容が無いため、承認できません。",
} as const;

const DOC_BLOCKED = {
  unidentified:
    "承認する試行が特定できないため、要件定義書を表示できません。承認できません。",
  loading: "要件定義書を読み込み中です。表示されるまで承認できません。",
  failed:
    "要件定義書を取得できていません。取得し直して内容を確かめるまで承認できません。",
  missing:
    "承認する試行の要件定義書が見つかりません。内容を確かめられないため、承認できません。",
  mismatch:
    "表示している要件定義書の試行が、承認する試行と違います。承認できません。",
} as const;

/**
 * 要件定義の承認を止める理由。取り込み時点のIssueと要件定義書の、どちらかが見られないときに返す。
 * 両方が見られるときは`null`。承認者が、実装の入力と承認の対象の両方を確かめてから押せるようにする。
 * 両方が見られないときは、取り込み時点のIssueの理由を先に返す。
 */
export function requirementsBlockedReason(
  snapshot: "loading" | "failed" | "empty" | "ready",
  doc: DocReadiness,
): string | null {
  if (snapshot !== "ready") {
    return SNAPSHOT_BLOCKED[snapshot];
  }
  return doc === "ready" ? null : DOC_BLOCKED[doc];
}

export function designBlockedReason(
  _input: DesignApprovalInput,
): string | null {
  return null;
}

/** 期限を過ぎた依頼に出す文。 */
export const EXPIRED_MESSAGE = "期限を過ぎているため、承認も却下もできません。";

/** 本文が長いとき、承認の前にGitHubで全文を確かめるよう求める文。 */
export const FULL_CHECK_MESSAGE =
  "本文が長いため、GitHubで全文を確かめるまで承認できません。";

type DecisionSurface = "decide" | "expired" | "redo_issue" | "waiting" | "none";

/**
 * 詳細に出す操作の面。
 * 承認待ちで期限内なら`decide`(承認と却下)、期限切れなら`expired`。
 * 承認済みでIssueをまだ作っていないIssue提案は`redo_issue`(Issueの作成のやり直し)。
 * それ以外の承認済みは`waiting`、他は`none`にする。
 */
export function decisionSurface(
  approval: Pick<
    SummaryApproval,
    "status" | "expires_at" | "kind" | "created_issue_number"
  >,
  nowMs: number,
): DecisionSurface {
  if (approval.status === "pending") {
    return isDecidable(approval, nowMs) ? "decide" : "expired";
  }
  if (approval.status === "approved") {
    return approval.kind === "issue_proposal" &&
      approval.created_issue_number === null
      ? "redo_issue"
      : "waiting";
  }
  return "none";
}

/** 承認済みで、操作の要らない依頼に出す文。 */
export function waitingMessage(kind: string): string {
  return kind === "issue_proposal"
    ? "承認済みです。起票を待っています。"
    : "承認済みです。処理の完了を待っています。";
}

/**
 * 承認を送ってよいかの確認。送れない理由の文を返し、送ってよければ`null`。
 * 承認の確認ダイアログで「承認する」を押した時点にも、同じ確認をやり直す。
 * ダイアログを開いている間に、期限を過ぎたり、前提が変わったりするためである。
 */
export function approveGateProblem(input: {
  readonly approval: Pick<SummaryApproval, "status" | "expires_at">;
  readonly nowMs: number;
  /** 取り込み内容を見られないなど、承認を止める理由。無ければ`null`。 */
  readonly blockedReason: string | null;
  readonly fullCheckRequired: boolean;
  readonly fullChecked: boolean;
}): string | null {
  if (input.blockedReason !== null) {
    return input.blockedReason;
  }
  if (!isDecidable(input.approval, input.nowMs)) {
    return EXPIRED_MESSAGE;
  }
  if (input.fullCheckRequired && !input.fullChecked) {
    return FULL_CHECK_MESSAGE;
  }
  return null;
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
  if (input.kind === "requirements") {
    return {
      subject: input.subject,
      idLabel,
      consequence: "承認すると、Claudeによる実装が始まります。取り消せません。",
    };
  }
  return {
    subject: input.subject,
    idLabel,
    consequence: "承認すると、承認の処理が始まります。取り消せません。",
  };
}

/**
 * 要件定義の却下の確認ダイアログの文。却下は作り直しになる。
 * 要件定義以外の却下は確認を求めないので`null`にする。
 */
export function rejectConfirmation(input: {
  readonly kind: string;
  readonly subject: string;
  readonly approvalRequestId: number;
}): ApprovalConfirmation | null {
  if (input.kind !== "requirements") {
    return null;
  }
  return {
    subject: input.subject,
    idLabel: `承認依頼 #${String(input.approvalRequestId)}`,
    consequence:
      "却下すると、要件定義を作り直します。作り直しでは、その時点の現在のIssueで、取り込み時点の内容が更新されます。",
  };
}

/** Issueの作成のやり直しの確認ダイアログの文。 */
export function redoConfirmation(input: {
  readonly subject: string;
  readonly approvalRequestId: number;
}): {
  readonly subject: string;
  readonly idLabel: string;
  readonly notes: readonly string[];
} {
  return {
    subject: input.subject,
    idLabel: `承認依頼 #${String(input.approvalRequestId)}`,
    notes: [
      "記録済みのラベルの選択で、Issueの作成をやり直します。",
      "すでに作られたIssueは、マーカーで見つけて再利用します。",
      "起票の処理に数分かかることがあるため、承認の直後は押さないでください。",
    ],
  };
}

type ProposalOriginText = {
  readonly text: string;
  /** 隠れた文字を置き換えたか。 */
  readonly replaced: boolean;
};

/** Issue提案の出どころの文。監査は期間、PRはPRの番号を出し、担当があれば添える。 */
export function proposalOrigin(proposal: {
  readonly origin: string;
  readonly period_label: string | null;
  readonly pr_number: number | null;
  readonly claimed_by: string | null;
}): ProposalOriginText {
  const parts: string[] = [];
  let replaced = false;
  if (proposal.origin === "audit") {
    if (proposal.period_label === null) {
      parts.push("監査");
    } else {
      const period = displayableIssueText(proposal.period_label);
      replaced = replaced || period.replaced;
      parts.push(`監査 ${period.text}`);
    }
  } else if (proposal.pr_number !== null) {
    parts.push(`PR #${String(proposal.pr_number)}`);
  }
  if (proposal.claimed_by !== null) {
    const claimedBy = displayableIssueText(proposal.claimed_by);
    replaced = replaced || claimedBy.replaced;
    parts.push(`担当: ${claimedBy.text}`);
  }
  return { text: parts.join(" ・ "), replaced };
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
  return {
    requirements:
      approval.kind === "requirements"
        ? requirementsPath(approval.work_item_id, approval.draft_attempt)
        : null,
    auditReport:
      approval.kind === "issue_proposal" && approval.origin === "audit"
        ? auditReportPath(approval.work_item_id)
        : null,
  };
}
