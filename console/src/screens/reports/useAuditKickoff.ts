import { useMemo, useState } from "react";
import { auditKickoffConfig } from "../../api/auditKickoffConfig.ts";
import { useWriteMutation } from "../../api/mutations.ts";
import type { AuditKickoffNotice } from "../../lib/auditKickoff.ts";

type AuditKickoff = {
  /** 起動を始める。実行中か、一覧が古いままなら何もしない。 */
  readonly start: () => void;
  /** 起動が実行中か、一覧を読み直せないままで止まっているか。 */
  readonly locked: boolean;
  /** 直近の起動の結果。次に起動するか、画面を離れるまで残す。 */
  readonly notice: AuditKickoffNotice | null;
};

/** 監査の手動起動。結果の知らせは、次に起動するか、画面を離れるまで残す。 */
export function useAuditKickoff(): AuditKickoff {
  const [notice, setNotice] = useState<AuditKickoffNotice | null>(null);
  const config = useMemo(() => auditKickoffConfig({ onNotice: setNotice }), []);
  const { submit, isLocked } = useWriteMutation(config);
  return {
    start: () => {
      if (submit()) {
        setNotice(null);
      }
    },
    locked: isLocked(),
    notice,
  };
}
