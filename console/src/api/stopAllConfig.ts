// 全停止と解除を、書き込みの共通の流れ(`writeRunner.ts`)に載せる設定。
// 置く操作と解除は同じキーでロックし、終わったら保留と凍結の取得と、システムの状態を読み直す。
// 結果の知らせは`onNotice`に渡す。

import {
  describeStopAllReleaseResult,
  describeStopAllResult,
  type ReleaseNotice,
  releaseNotice,
  STALE_LIST_NOTICE,
} from "../lib/writeNotices.ts";
import type {
  StopAllReleaseResult,
  StopAllResult,
} from "./guards/writeResults.ts";
import { holdsQueryKey } from "./holdsQueries.ts";
import { systemStatusQueryKey } from "./systemQueries.ts";
import { STOP_ALL_WRITE_KEY } from "./writeLocks.ts";
import type { WriteRunnerConfig } from "./writeRunner.ts";
import { releaseStopAll, stopAll } from "./writes.ts";

type StopAllDeps<TInput, TResult> = {
  readonly onNotice: (notice: ReleaseNotice) => void;
  /** テストで差し替える。既定は`writes.ts`の関数。 */
  readonly run?: (input: TInput) => Promise<TResult>;
};

const INVALIDATES = [holdsQueryKey, systemStatusQueryKey];

/** 全停止を置く。入力は理由である。 */
export function stopAllConfig(
  deps: StopAllDeps<string, StopAllResult>,
): WriteRunnerConfig<string, StopAllResult> {
  return {
    keyOf: () => STOP_ALL_WRITE_KEY,
    run: deps.run ?? ((reason) => stopAll(reason)),
    invalidates: INVALIDATES,
    onOutcome: (outcome) => {
      deps.onNotice(releaseNotice(outcome, describeStopAllResult));
    },
    onStale: () => {
      deps.onNotice(STALE_LIST_NOTICE);
    },
  };
}

/** 全停止を解除する。入力は持たないので`null`を渡す。 */
export function stopAllReleaseConfig(
  deps: StopAllDeps<null, StopAllReleaseResult>,
): WriteRunnerConfig<null, StopAllReleaseResult> {
  return {
    keyOf: () => STOP_ALL_WRITE_KEY,
    run: deps.run ?? (() => releaseStopAll()),
    invalidates: INVALIDATES,
    onOutcome: (outcome) => {
      deps.onNotice(releaseNotice(outcome, describeStopAllReleaseResult));
    },
    onStale: () => {
      deps.onNotice(STALE_LIST_NOTICE);
    },
  };
}
