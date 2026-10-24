// Factory Consoleから保留を1件解除するscript。
//
// 解除する主体は人(`human`)に固定し、引数から受けない。操作者は、ジョブのWindmill実行文脈から
// 導く(`deriveApprover`)。導けないときは何も変えずに拒否する。
// `session`や`factory`が置いた保留も解除できる。保留は止めるための補助で、解除は止めが外れる向きの操作なので、
// 解除した操作者は情報の通知に残す。通知を書けなくても、解除は取り消さない。
// 保留を置く操作は、このscriptに持たない。
// 同じ保留への重複した呼び出しは、解除済みとして成功を返す。

import { deriveApprover } from "./lib/approver.ts";
import {
  clipDisplay,
  HUMAN_RELEASER,
  holdSubject,
  type ReleaseAudit,
  releaseNoticeMessage,
} from "./lib/console_holds_support.ts";
import { addNoticeUnlessUnresolved, defaultSqlClient } from "./lib/db.ts";
import {
  type HoldActor,
  type HoldReadOutcome,
  type HoldRow,
  listActiveHolds,
  type Outcome,
  releaseHold,
} from "./lib/holds.ts";
import { logger } from "./lib/log.ts";
import type { NoticeRecord } from "./lib/types.ts";

/** `releaseHold`が、解除済みの保留に返す理由。 */
export const ALREADY_RELEASED_REASON = "the hold is already released";

const NOTICE_KIND = "hold_released";

/**
 * 解除の結果。`was_active`は、解除する前に有効だったか。期限切れの行を片付けただけのときは偽で、通知を残さない。
 * 有効な保留の一覧を読めなかったときは、有効だったものとして扱う。
 * `audit`は、通知を試みたときだけ付く。
 */
export type HoldReleaseResult = {
  readonly ok: true;
  readonly status: "released" | "already_released";
  readonly hold_id: number;
  readonly was_active: boolean;
  readonly audit?: ReleaseAudit;
};

/** `releaseHoldFromConsole`が使う外部の操作。テストでは差し替える。 */
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

/**
 * 保留`holdId`を人として解除する。
 * `holdId`が正の安全な整数でないとき、操作者を導けないとき、解除に失敗したときは例外を投げる。
 * 解除済みなら何も変えずに`already_released`を返す。
 * 有効だった保留を解除したときだけ、情報の通知を残す。
 */
export async function releaseHoldFromConsole(
  holdId: number,
  deps: HoldReleaseDeps,
): Promise<HoldReleaseResult> {
  if (!Number.isSafeInteger(holdId) || holdId < 1) {
    throw new Error(
      `hold_release: "hold_id" must be a positive integer (got ${String(holdId)})`,
    );
  }
  const operator = deps.deriveApprover();

  const active = await deps.listActiveHolds();
  const found = active.ok
    ? (active.value.find((row) => row.id === holdId) ?? null)
    : null;
  const wasActive = !active.ok || found !== null;

  const released = await deps.releaseHold(holdId, HUMAN_RELEASER);
  if (!released.ok) {
    if (released.reason === ALREADY_RELEASED_REASON) {
      return {
        ok: true,
        status: "already_released",
        hold_id: holdId,
        was_active: false,
      };
    }
    throw new Error(`hold_release: ${released.reason}`);
  }
  if (!wasActive) {
    return {
      ok: true,
      status: "released",
      hold_id: holdId,
      was_active: false,
    };
  }

  const audit = await recordRelease(
    {
      kind: NOTICE_KIND,
      message: releaseNoticeMessage(
        holdSubject(found, holdId),
        operator,
        deps.now(),
      ),
    },
    deps,
  );
  return {
    ok: true,
    status: "released",
    hold_id: holdId,
    was_active: true,
    audit,
  };
}

async function recordRelease(
  record: NoticeRecord,
  deps: Pick<HoldReleaseDeps, "addNotice" | "warn">,
): Promise<ReleaseAudit> {
  try {
    await deps.addNotice(record);
    return "recorded";
  } catch (err) {
    deps.warn("hold_release: could not record the release notice", {
      error: err instanceof Error ? err.message : String(err),
    });
    return "failed";
  }
}

/** Consoleから保留を1件解除する。操作者はジョブの実行文脈から導く。 */
export async function main(hold_id: number): Promise<HoldReleaseResult> {
  const log = logger("hold_release");
  let operator = "";
  const result = await releaseHoldFromConsole(hold_id, {
    deriveApprover: () => {
      operator = deriveApprover({
        WM_USERNAME: process.env.WM_USERNAME,
        WM_EMAIL: process.env.WM_EMAIL,
      });
      return operator;
    },
    listActiveHolds: () => listActiveHolds({}, defaultSqlClient),
    releaseHold: (id, actor) => releaseHold(id, actor, defaultSqlClient),
    addNotice: (record) => addNoticeUnlessUnresolved(record),
    now: () => new Date(),
    warn: (message, fields) => {
      log.warn(message, fields);
    },
  });
  log.info("hold release finished", {
    operator: clipDisplay(operator, 100),
    hold_id: result.hold_id,
    status: result.status,
    was_active: result.was_active,
    ...(result.audit === undefined ? {} : { audit: result.audit }),
  });
  return result;
}
