// 反映の承認待ちの表示の整形。パスは信頼できない文字列として、見えない文字を表記にしてから描く。

import type { HoldsSnapshot } from "../api/guards/holds.ts";
import { safeText } from "./safeText.ts";

export type DeployApprovalItem = {
  readonly sha: string;
  readonly requestedAt: string;
  readonly paths: readonly string[];
  /** 一覧から外した保護パスの数。 */
  readonly hiddenPathCount: number;
};

export type DeployApprovalsView =
  | { readonly kind: "none" }
  | { readonly kind: "pending"; readonly items: readonly DeployApprovalItem[] }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * 保留と凍結の取得から、承認待ちの表示を作る。
 * 承認待ちが無いとき、旧版のbackendが返さないときは`none`にし、何も描かない。
 */
export function deployApprovalsView(
  snapshot: HoldsSnapshot,
): DeployApprovalsView {
  const read = snapshot.deploy_approvals;
  if (read === undefined) return { kind: "none" };
  if (!read.ok) return { kind: "failed", reason: safeText(read.reason) };
  if (read.pending.length === 0) return { kind: "none" };
  return {
    kind: "pending",
    items: read.pending.map((row) => ({
      sha: row.sha,
      requestedAt: row.requested_at,
      paths: row.protected_paths.map(safeText),
      hiddenPathCount: Math.max(
        0,
        row.protected_path_count - row.protected_paths.length,
      ),
    })),
  };
}
