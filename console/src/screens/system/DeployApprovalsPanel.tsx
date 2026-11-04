import type {
  DeployApprovalItem,
  DeployApprovalsView,
} from "../../lib/deployApprovalsView.ts";

export type DeployDecisionRequest = {
  readonly item: DeployApprovalItem;
  readonly decision: "approve" | "reject";
};

export function DeployApprovalsPanel(_props: {
  view: DeployApprovalsView;
  now: number;
  isLocked: (sha: string) => boolean;
  onRequest: (request: DeployDecisionRequest) => void;
}) {
  return null;
}
