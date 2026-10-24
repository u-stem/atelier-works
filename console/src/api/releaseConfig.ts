// 保留と凍結の解除を、書き込みの共通の流れ(`writeRunner.ts`)に載せる設定。
// 対象ごとにロックし、解除の後は、保留と凍結の取得と、解除の通知が出るシステムの状態を読み直す。
// 結果の知らせは`onNotice`に渡す。

import {
  describeFreezeReleaseResult,
  describeHoldReleaseResult,
  type ReleaseNotice,
  releaseNotice,
  STALE_LIST_NOTICE,
} from "../lib/writeNotices.ts";
import type {
  FreezeReleaseResult,
  HoldReleaseResult,
} from "./guards/writeResults.ts";
import { holdsQueryKey } from "./holdsQueries.ts";
import { systemStatusQueryKey } from "./systemQueries.ts";
import { writeTargetKey } from "./writeLocks.ts";
import type { WriteRunnerConfig } from "./writeRunner.ts";
import { releaseFreeze, releaseHold } from "./writes.ts";

type ReleaseDeps<TInput, TResult> = {
  /** 結果と、一覧を読み直せなかったことを画面に残す。 */
  readonly onNotice: (notice: ReleaseNotice) => void;
  /** テストで差し替える。既定は`writes.ts`の関数。 */
  readonly run?: (input: TInput) => Promise<TResult>;
};

const INVALIDATES = [holdsQueryKey, systemStatusQueryKey];

export function holdReleaseConfig(
  deps: ReleaseDeps<number, HoldReleaseResult>,
): WriteRunnerConfig<number, HoldReleaseResult> {
  return {
    keyOf: (holdId) => writeTargetKey("hold", holdId),
    run: deps.run ?? ((holdId) => releaseHold(holdId)),
    invalidates: INVALIDATES,
    onOutcome: (outcome) => {
      deps.onNotice(releaseNotice(outcome, describeHoldReleaseResult));
    },
    onStale: () => {
      deps.onNotice(STALE_LIST_NOTICE);
    },
  };
}

export function freezeReleaseConfig(
  deps: ReleaseDeps<string, FreezeReleaseResult>,
): WriteRunnerConfig<string, FreezeReleaseResult> {
  return {
    keyOf: (freezeId) => writeTargetKey("freeze", freezeId),
    run: deps.run ?? ((freezeId) => releaseFreeze(freezeId)),
    invalidates: INVALIDATES,
    onOutcome: (outcome) => {
      deps.onNotice(releaseNotice(outcome, describeFreezeReleaseResult));
    },
    onStale: () => {
      deps.onNotice(STALE_LIST_NOTICE);
    },
  };
}
