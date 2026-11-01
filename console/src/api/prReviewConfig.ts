// PRレビューの投入を、書き込みの共通の流れ(`writeRunner.ts`)に載せる設定。

import type { WriteOutcome } from "./executeWrite.ts";
import type { PrReviewSubmitResult } from "./guards/writeResults.ts";
import type { WriteRunnerConfig } from "./writeRunner.ts";
import type { PrReviewSubmitInput } from "./writes.ts";

type PrReviewDeps = {
  readonly onOutcome: (outcome: WriteOutcome<PrReviewSubmitResult>) => void;
  readonly run?: (input: PrReviewSubmitInput) => Promise<PrReviewSubmitResult>;
};

export function prReviewConfig(
  deps: PrReviewDeps,
): WriteRunnerConfig<PrReviewSubmitInput, PrReviewSubmitResult> {
  return {
    keyOf: () => "",
    run: deps.run ?? (() => Promise.reject(new Error("stub"))),
    invalidates: [["stub"]],
    onOutcome: deps.onOutcome,
    onStale: () => undefined,
  };
}
