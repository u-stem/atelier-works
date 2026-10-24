// Consoleの保留と凍結の画面が読む、有効な保留と凍結の一覧を返すscript。
//
// 読むだけで、何も書かない。保留の表と凍結の変数は別々の源なので、片方が読めなくても
// もう片方を返す。読めなかった源は、空の一覧ではなく失敗の種類と理由で返す
// (読めないことを「保留なし」と取り違えさせないため)。
// 例外は投げない。画面が源ごとに失敗を表示できるようにする。

import wmillDefault, * as wmill from "windmill-client@1.817.0";
import {
  freezesReadView,
  type HoldsSnapshot,
  holdsReadView,
  readFreezeState,
} from "./lib/console_holds_support.ts";
import { defaultSqlClient } from "./lib/db.ts";
import { type FreezePorts, sdkFreezePorts } from "./lib/freeze_apply.ts";
import {
  type HoldReadOutcome,
  type HoldRow,
  listActiveHolds,
} from "./lib/holds.ts";

export type HoldsSnapshotDeps = {
  readonly listHolds: () => Promise<HoldReadOutcome<readonly HoldRow[]>>;
  readonly ports: FreezePorts;
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

/** 有効な保留と凍結を集める。片方の失敗はもう片方に影響しない。 */
export async function loadHoldsSnapshot(
  deps: HoldsSnapshotDeps,
): Promise<HoldsSnapshot> {
  const [holds, freezeState] = await Promise.all([
    readHolds(deps),
    readFreezeState(deps.ports),
  ]);
  return {
    holds: holdsReadView(holds),
    freezes: freezesReadView(freezeState, deps.ports.now()),
  };
}

/** Consoleの保留と凍結の画面に、有効な保留と凍結を返す。 */
export async function main(): Promise<HoldsSnapshot> {
  return await loadHoldsSnapshot({
    listHolds: () => listActiveHolds({}, defaultSqlClient),
    ports: sdkFreezePorts(wmill, wmillDefault.getWorkspace(), () => new Date()),
  });
}
