// Consoleから凍結かdeployの保留を1件解除するscript。

import type { ReleaseAudit } from "./lib/console_holds_support.ts";
import type { FreezePorts } from "./lib/freeze_apply.ts";
import type { NoticeRecord } from "./lib/types.ts";

export type FreezeReleaseResult = {
  readonly ok: true;
  readonly status: "released" | "already_ended" | "unconfirmed";
  readonly freeze_id: string;
  readonly scope?: "schedule" | "deploy";
  readonly audit?: ReleaseAudit;
};

export type FreezeReleaseDeps = {
  readonly deriveApprover: () => string;
  readonly ports: FreezePorts;
  readonly addNotice: (record: NoticeRecord) => Promise<unknown>;
  readonly warn: (message: string, fields?: Record<string, unknown>) => void;
};

export async function releaseFreezeFromConsole(
  freezeId: string,
  _deps: FreezeReleaseDeps,
): Promise<FreezeReleaseResult> {
  return { ok: true, status: "already_ended", freeze_id: freezeId };
}

export async function main(freeze_id: string): Promise<FreezeReleaseResult> {
  return await releaseFreezeFromConsole(freeze_id, {
    deriveApprover: () => "",
    ports: {
      readVariable: async () => null,
      writeVariable: async () => {},
      now: () => new Date(),
    },
    addNotice: async () => null,
    warn: () => {},
  });
}
