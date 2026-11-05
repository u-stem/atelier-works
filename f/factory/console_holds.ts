// Consoleの保留と凍結の画面が読む、有効な保留と凍結と、反映の承認待ちを返すscript。
//
// 読むだけで、何も書かない。保留の表、凍結の変数、承認待ちは別々の源なので、
// 1つが読めなくてもほかを返す。読めなかった源は、空の一覧ではなく失敗の種類と理由で返す
// (読めないことを「保留なし」と取り違えさせないため)。
// 例外は投げない。画面が源ごとに失敗を表示できるようにする。

import wmillDefault, * as wmill from "windmill-client@1.817.0";
import {
  deployApprovalsReadView,
  freezesReadView,
  type HoldsSnapshot,
  holdsReadView,
  readFreezeState,
} from "./lib/console_holds_support.ts";
import { defaultSqlClient } from "./lib/db.ts";
import {
  type DeployApproval,
  listPendingDeployApprovals,
} from "./lib/deploy_approvals.ts";
import { type FreezePorts, sdkFreezePorts } from "./lib/freeze_apply.ts";
import type { Outcome } from "./lib/freezes.ts";
import {
  type HoldReadOutcome,
  type HoldRow,
  listActiveHolds,
} from "./lib/holds.ts";

export type HoldsSnapshotDeps = {
  readonly listHolds: () => Promise<HoldReadOutcome<readonly HoldRow[]>>;
  readonly ports: FreezePorts;
  readonly listPendingDeployApprovals: () => Promise<readonly DeployApproval[]>;
};

async function readHolds(
  deps: HoldsSnapshotDeps,
): Promise<HoldReadOutcome<readonly HoldRow[]>> {
  try {
    return await deps.listHolds();
  } catch (err) {
    return {
      ok: false,
      kind: "read_failed",
      reason: `could not read the holds: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function readDeployApprovals(
  deps: HoldsSnapshotDeps,
): Promise<Outcome<readonly DeployApproval[]>> {
  try {
    return { ok: true, value: await deps.listPendingDeployApprovals() };
  } catch (err) {
    return {
      ok: false,
      reason: `could not read the deploy approvals: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** 有効な保留と凍結、反映の承認待ちを集める。1つの源の失敗はほかに影響しない。 */
export async function loadHoldsSnapshot(
  deps: HoldsSnapshotDeps,
): Promise<HoldsSnapshot> {
  const [holds, freezeState, approvals] = await Promise.all([
    readHolds(deps),
    readFreezeState(deps.ports),
    readDeployApprovals(deps),
  ]);
  return {
    holds: holdsReadView(holds),
    freezes: freezesReadView(freezeState, deps.ports.now()),
    deploy_approvals: deployApprovalsReadView(approvals),
  };
}

/** Consoleの保留と凍結の画面に、有効な保留と凍結と、反映の承認待ちを返す。 */
export async function main(): Promise<HoldsSnapshot> {
  return await loadHoldsSnapshot({
    listHolds: () => listActiveHolds({}, defaultSqlClient),
    ports: sdkFreezePorts(wmill, wmillDefault.getWorkspace(), () => new Date()),
    listPendingDeployApprovals: () =>
      listPendingDeployApprovals(defaultSqlClient),
  });
}
