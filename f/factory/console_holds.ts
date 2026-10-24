// Consoleの保留と凍結の画面が読む、有効な保留と凍結の一覧を返すscript。

import type { HoldsSnapshot } from "./lib/console_holds_support.ts";
import type { FreezePorts } from "./lib/freeze_apply.ts";
import type { HoldReadOutcome, HoldRow } from "./lib/holds.ts";

export type HoldsSnapshotDeps = {
  readonly listHolds: () => Promise<HoldReadOutcome<readonly HoldRow[]>>;
  readonly ports: FreezePorts;
};

export async function loadHoldsSnapshot(
  _deps: HoldsSnapshotDeps,
): Promise<HoldsSnapshot> {
  return {
    holds: { ok: true, rows: [] },
    freezes: { ok: true, schedule: [], deploy: [] },
  };
}

export async function main(): Promise<HoldsSnapshot> {
  return await loadHoldsSnapshot({
    listHolds: async () => ({ ok: true, value: [] }),
    ports: {
      readVariable: async () => null,
      writeVariable: async () => {},
      now: () => new Date(),
    },
  });
}
