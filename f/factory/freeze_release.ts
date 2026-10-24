// Factory Consoleから凍結かdeployの保留を1件解除するscript。
//
// 解除する主体は人(`human`)に固定し、引数から受けない。操作者は、ジョブのWindmill実行文脈から
// 導く(`deriveApprover`)。導けないときは何も変えずに拒否する。
// 変数への書き込みは`mutateFreezeState`だけが行い、書く直前に読み直した状態へ解除を当てる。
// 凍結の行は解除した主体を残さないので、操作者は情報の通知とジョブの記録に残す。
// 変数の読み書きは排他しない。書いた後に読み直し、解除が残っていないか、書いた時点で有効だった行が欠けていれば
// `unconfirmed`を返す。終わった行が片付けられても、`unconfirmed`にしない。
// 同じ行への重複した呼び出しは、終わった行として成功を返す。

import wmillDefault, * as wmill from "windmill-client@1.817.0";
import { deriveApprover } from "./lib/approver.ts";
import {
  clipDisplay,
  freezeSubject,
  HUMAN_RELEASER,
  type ReleaseAudit,
  readFreezeState,
  recordRelease,
  releaseNoticeMessage,
} from "./lib/console_holds_support.ts";
import { addNoticeUnlessUnresolved } from "./lib/db.ts";
import {
  type FreezePorts,
  mutateFreezeState,
  sdkFreezePorts,
} from "./lib/freeze_apply.ts";
import {
  type DeployFreezeEntry,
  type FreezeEntry,
  type FreezeState,
  isActive,
  type Outcome,
  releaseFreeze,
} from "./lib/freezes.ts";
import { logger } from "./lib/log.ts";
import type { NoticeRecord } from "./lib/types.ts";

const FREEZE_ID_PATTERN = /^[0-9a-f]{8}$/;
/**
 * 解除の結果。`unconfirmed`は、書いた後に読み直した変数に解除が残っていなかったこと(別の書き手と競合した)。
 * `scope`と`audit`は`released`のときだけ付く。`audit`は通知を残せたか。
 */
export type FreezeReleaseResult = {
  readonly ok: true;
  readonly status: "released" | "already_ended" | "unconfirmed";
  readonly freeze_id: string;
  readonly scope?: "schedule" | "deploy";
  readonly audit?: ReleaseAudit;
};

/** `releaseFreezeFromConsole`が使う外部の操作。テストでは差し替える。 */
export type FreezeReleaseDeps = {
  readonly deriveApprover: () => string;
  readonly ports: FreezePorts;
  readonly addNotice: (record: NoticeRecord) => Promise<unknown>;
  readonly warn: (message: string, fields?: Record<string, unknown>) => void;
};

/**
 * 書く直前に読んだ状態から見た、解除する行と、ほかの行。
 * `others`は、書いた時点で有効だった行だけである。終わった行は、別の書き手が片付けてよいので数えない。
 */
type Seen = {
  readonly scope: "schedule" | "deploy";
  readonly target: string | null;
  readonly others: readonly { readonly id: string; readonly expiresAt: Date }[];
};

function rowOf(
  state: FreezeState,
  id: string,
): {
  readonly row: FreezeEntry | DeployFreezeEntry;
  readonly scope: "schedule" | "deploy";
} | null {
  const schedule = state.freezes.find((entry) => entry.id === id);
  if (schedule !== undefined) return { row: schedule, scope: "schedule" };
  const deploy = state.deploy_freezes.find((entry) => entry.id === id);
  return deploy === undefined ? null : { row: deploy, scope: "deploy" };
}

function allRows(state: FreezeState): (FreezeEntry | DeployFreezeEntry)[] {
  return [...state.freezes, ...state.deploy_freezes];
}

/** 書いた時点で有効だった、解除する行以外の行。 */
function activeOthers(
  state: FreezeState,
  id: string,
  now: Date,
): Seen["others"] {
  return allRows(state)
    .filter((entry) => entry.id !== id && isActive(entry, now))
    .map((entry) => ({ id: entry.id, expiresAt: new Date(entry.expires_at) }));
}

/**
 * 書いた後の状態に、解除が残り、書いた時点で有効だった行が欠けていないか。
 * 読み直しの時点で期限が過ぎた行は、片付けられていてよい。
 */
function confirmed(
  after: FreezeState,
  id: string,
  seen: Seen,
  now: Date,
): boolean {
  const found = rowOf(after, id);
  if (found === null || found.row.released_at === null) return false;
  const ids = new Set(allRows(after).map((entry) => entry.id));
  return seen.others.every(
    (other) => ids.has(other.id) || other.expiresAt.getTime() <= now.getTime(),
  );
}

/**
 * 凍結かdeployの保留`freezeId`を人として解除する。
 * idが8桁の16進でないとき、操作者を導けないとき、変数を読めない・壊れているとき、書けないときは例外を投げる。
 * 行が無いか、すでに終わっている(解除済みか期限切れ)なら、何も書かずに`already_ended`を返す。
 * 書いた後に読み直し、解除が残っていなければ`unconfirmed`を返す(通知は残さない)。
 */
export async function releaseFreezeFromConsole(
  freezeId: string,
  deps: FreezeReleaseDeps,
): Promise<FreezeReleaseResult> {
  if (!FREEZE_ID_PATTERN.test(freezeId)) {
    throw new Error(
      `freeze_release: "freeze_id" must be 8 lowercase hexadecimal characters (got ${JSON.stringify(freezeId)})`,
    );
  }
  const operator = deps.deriveApprover();

  const observed: { seen: Seen | null; ended: boolean } = {
    seen: null,
    ended: false,
  };
  let outcome: Outcome<FreezeState>;
  try {
    outcome = await mutateFreezeState(deps.ports, (state, now) => {
      const found = rowOf(state, freezeId);
      if (found === null) {
        observed.ended = true;
        return { ok: false, reason: "no freeze has that id" };
      }
      if (!isActive(found.row, now)) {
        observed.ended = true;
        return { ok: false, reason: "the freeze is no longer active" };
      }
      observed.seen = {
        scope: found.scope,
        target: "target" in found.row ? found.row.target : null,
        others: activeOthers(state, freezeId, now),
      };
      return releaseFreeze(state, freezeId, HUMAN_RELEASER, now);
    });
  } catch (err) {
    throw new Error(
      `freeze_release: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!outcome.ok) {
    if (observed.ended) {
      return { ok: true, status: "already_ended", freeze_id: freezeId };
    }
    throw new Error(`freeze_release: ${outcome.reason}`);
  }
  const seen = observed.seen;
  if (seen === null) {
    throw new Error("freeze_release: the released row was not observed");
  }

  const after = await readFreezeState(deps.ports);
  if (!after.ok || !confirmed(after.value, freezeId, seen, deps.ports.now())) {
    deps.warn("freeze_release: could not confirm the release", {
      freeze_id: freezeId,
    });
    return { ok: true, status: "unconfirmed", freeze_id: freezeId };
  }

  const audit = await recordRelease(
    "freeze_release",
    releaseNoticeMessage(
      freezeSubject(freezeId, seen.target),
      operator,
      deps.ports.now(),
    ),
    deps,
  );
  return {
    ok: true,
    status: "released",
    freeze_id: freezeId,
    scope: seen.scope,
    audit,
  };
}

/** Consoleから凍結かdeployの保留を1件解除する。操作者はジョブの実行文脈から導く。 */
export async function main(freeze_id: string): Promise<FreezeReleaseResult> {
  const log = logger("freeze_release");
  let operator = "";
  const result = await releaseFreezeFromConsole(freeze_id, {
    deriveApprover: () => {
      operator = deriveApprover({
        WM_USERNAME: process.env.WM_USERNAME,
        WM_EMAIL: process.env.WM_EMAIL,
      });
      return operator;
    },
    ports: sdkFreezePorts(wmill, wmillDefault.getWorkspace(), () => new Date()),
    addNotice: (record) => addNoticeUnlessUnresolved(record),
    warn: (message, fields) => {
      log.warn(message, fields);
    },
  });
  log.info("freeze release finished", {
    operator: clipDisplay(operator, 100),
    freeze_id: result.freeze_id,
    status: result.status,
    ...(result.scope === undefined ? {} : { scope: result.scope }),
    ...(result.audit === undefined ? {} : { audit: result.audit }),
  });
  return result;
}
