// 監査レポートの一覧と本文に出す文言と、行き先を決める。

type ProposalCounts = {
  readonly pending_count: number;
  readonly approved_count: number;
  readonly rejected_count: number;
};

/** 一覧の行に出す、提案の判断の内訳。 */
export function auditProposalBreakdown(counts: ProposalCounts): string {
  return `提案: 未決定 ${String(counts.pending_count)} ・ 承認 ${String(counts.approved_count)} ・ 却下 ${String(counts.rejected_count)}`;
}

/** 本文の見出しに添える、提案の総数と内訳。 */
export function auditProposalTotal(counts: ProposalCounts): string {
  const total =
    counts.pending_count + counts.approved_count + counts.rejected_count;
  return `提案${String(total)}件(承認待ち${String(counts.pending_count)}・承認${String(counts.approved_count)}・却下${String(counts.rejected_count)})`;
}

/** 監査レポートの本文の経路。routerの基準(`/console`)からの絶対パスで書く。 */
export function auditReportPath(workItemId: number): string {
  return `/reports/audit/${String(workItemId)}`;
}

/** 本文の画面の題。 */
export function auditReportTitle(periodLabel: string): string {
  return `監査レポート ${periodLabel}`;
}
