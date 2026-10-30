import type { ApprovalDesignDoc } from "../../api/guards/approvalDesignDoc.ts";
import type { SummaryApproval } from "../../api/guards/summary.ts";

export function DesignTextView(_props: { text: string }) {
  return null;
}

export function DesignDocBody(_props: { doc: ApprovalDesignDoc }) {
  return null;
}

export function DesignReview(_props: {
  approval: SummaryApproval;
  title: string;
  now: number;
}) {
  return null;
}
