// 監査の手動起動を、書き込みの共通の流れ(`writeRunner.ts`)に載せる設定。
// 起動は対象を持たないので、ロックのキーを1つに固定する。
// 結果の知らせは`onNotice`に渡す。起動の後は、監査レポートの一覧を読み直す。

import {
  type AuditKickoffNotice,
  auditKickoffNotice,
  staleAuditNotice,
} from "../lib/auditKickoff.ts";
import { auditIndexQueryKey } from "./auditQueries.ts";
import type { AuditKickoffResult } from "./guards/writeResults.ts";
import { AUDIT_WRITE_KEY } from "./writeLocks.ts";
import type { WriteRunnerConfig } from "./writeRunner.ts";
import { kickoffAudit } from "./writes.ts";

type AuditKickoffDeps = {
  /** 結果と、一覧を読み直せなかったことを画面に残す。 */
  readonly onNotice: (notice: AuditKickoffNotice) => void;
  /** テストで差し替える。既定は`kickoffAudit`。 */
  readonly run?: () => Promise<AuditKickoffResult>;
};

export function auditKickoffConfig(
  deps: AuditKickoffDeps,
): WriteRunnerConfig<void, AuditKickoffResult> {
  return {
    keyOf: () => AUDIT_WRITE_KEY,
    run: deps.run ?? (() => kickoffAudit()),
    invalidates: [auditIndexQueryKey],
    onOutcome: (outcome) => {
      deps.onNotice(auditKickoffNotice(outcome));
    },
    onStale: () => {
      deps.onNotice(staleAuditNotice());
    },
  };
}
