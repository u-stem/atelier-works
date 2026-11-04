import type { HoldsSnapshot } from "../api/guards/holds.ts";

export type DeployApprovalItem = {
  readonly sha: string;
  readonly requestedAt: string;
  readonly paths: readonly string[];
  readonly hiddenPathCount: number;
};

export type DeployApprovalsView =
  | { readonly kind: "none" }
  | { readonly kind: "pending"; readonly items: readonly DeployApprovalItem[] }
  | { readonly kind: "failed"; readonly reason: string };

export function deployApprovalsView(
  _snapshot: HoldsSnapshot,
): DeployApprovalsView {
  return { kind: "none" };
}
