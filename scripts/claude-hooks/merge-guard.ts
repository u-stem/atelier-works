// 暫定の実装。常に許可する。

import { ALLOW, type BashToolInput, type Decision } from "./hook-io.ts";
import type { FreezeReading, MergeHoldReading } from "./merge-read.ts";

export type GuardReaders = {
  readonly readMergeHolds: () => Promise<MergeHoldReading>;
  readonly readDeployFreezes: () => Promise<FreezeReading>;
};

export function evaluateMergeGuard(
  _input: BashToolInput,
  _load: () => Promise<GuardReaders>,
  _timeoutMs?: number,
): Promise<Decision> {
  return Promise.resolve(ALLOW);
}
