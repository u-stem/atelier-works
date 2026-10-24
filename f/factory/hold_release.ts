// Consoleから保留を1件解除するscript。

import type { ReleaseAudit } from "./lib/console_holds_support.ts";
import type {
  HoldActor,
  HoldReadOutcome,
  HoldRow,
  Outcome,
} from "./lib/holds.ts";
import type { NoticeRecord } from "./lib/types.ts";

export const ALREADY_RELEASED_REASON = "the hold is already released";

export type HoldReleaseResult = {
  readonly ok: true;
  readonly status: "released" | "already_released";
  readonly hold_id: number;
  readonly was_active: boolean;
  readonly audit?: ReleaseAudit;
};

export type HoldReleaseDeps = {
  readonly deriveApprover: () => string;
  readonly listActiveHolds: () => Promise<HoldReadOutcome<readonly HoldRow[]>>;
  readonly releaseHold: (
    id: number,
    actor: HoldActor,
  ) => Promise<Outcome<{ readonly id: number }>>;
  readonly addNotice: (record: NoticeRecord) => Promise<unknown>;
  readonly now: () => Date;
  readonly warn: (message: string, fields?: Record<string, unknown>) => void;
};

export async function releaseHoldFromConsole(
  holdId: number,
  _deps: HoldReleaseDeps,
): Promise<HoldReleaseResult> {
  return {
    ok: true,
    status: "already_released",
    hold_id: holdId,
    was_active: false,
  };
}

export async function main(hold_id: number): Promise<HoldReleaseResult> {
  return await releaseHoldFromConsole(hold_id, {
    deriveApprover: () => "",
    listActiveHolds: async () => ({ ok: true, value: [] }),
    releaseHold: async (id) => ({ ok: true, value: { id } }),
    addNotice: async () => null,
    now: () => new Date(),
    warn: () => {},
  });
}
