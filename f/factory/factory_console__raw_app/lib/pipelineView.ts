// パイプライン一覧の行から、表示に使う値(状態の色、リンク)を決める。
// `tabs/PipelineTab.tsx`が使う。

import { safeGitHubUrl } from "./githubLink";
import type { PipelineRow } from "./types";

export type StatusVariant = "success" | "warning" | "danger" | "neutral";

const SUCCESS_STATUSES = new Set([
  "approved",
  "reviewed",
  "audited",
  "pr_open",
]);
const DANGER_STATUSES = new Set(["failed", "blocked", "needs_human"]);

/**
 * 状態の値を、ステータスピルの色の種類に分ける。
 * 承認待ちは`warning`、完了に近い状態(`pr_open`を含む)は`success`、
 * 失敗や人手待ちは`danger`、それ以外は`neutral`。
 */
export function statusVariant(status: string): StatusVariant {
  if (status === "awaiting_approval") {
    return "warning";
  }
  if (SUCCESS_STATUSES.has(status)) {
    return "success";
  }
  if (DANGER_STATUSES.has(status)) {
    return "danger";
  }
  return "neutral";
}

export type PipelineLink = { readonly label: string; readonly url: string };

/**
 * Issue/PR列のリンクを返す。
 * IssueのURLと番号があればIssueを、無ければPR番号から組み立てたPRを指す。
 * URLがGitHubのIssue/PRの形でなければ、次の候補へ進まずnullを返す。
 */
export function issueOrPrLink(
  row: Pick<
    PipelineRow,
    "issue_url" | "issue_number" | "pr_number" | "owner" | "repo"
  >,
): PipelineLink | null {
  if (row.issue_url !== null && row.issue_number !== null) {
    const url = safeGitHubUrl(row.issue_url);
    if (url === null) return null;
    return { label: `#${row.issue_number}`, url };
  }
  if (row.pr_number !== null) {
    const url = safeGitHubUrl(
      `https://github.com/${row.owner}/${row.repo}/pull/${row.pr_number}`,
    );
    if (url === null) return null;
    return { label: `PR #${row.pr_number}`, url };
  }
  return null;
}

/** `pr_url`をPR列のリンクにする。PRのURLでなければnullを返す。 */
export function prLink(prUrl: string | null): PipelineLink | null {
  const url = safeGitHubUrl(prUrl);
  if (url === null) return null;
  const match = /\/pull\/([1-9][0-9]*)$/.exec(url);
  if (match === null) return null;
  return { label: `PR #${match[1]}`, url };
}
