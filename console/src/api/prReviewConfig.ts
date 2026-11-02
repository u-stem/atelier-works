// PRレビューの投入を、書き込みの共通の流れ(`writeRunner.ts`)に載せる設定。
// 投入は対象を持たないので、ロックのキーを1つに固定する。
// 冪等キーは使わない。同じPRの二重の投入は、入口と登録のステップが断る。
// 投入の直後に読み直す取得は無い。作業項目は登録のステップが後で作るので、直後に読み直しても変わらない。
// 読み直しが無いので、一覧が古いままで止める場面も無く、`onStale`は呼ばれない。
// 結果は、呼び出した画面の部品が`onOutcome`で受ける。画面を離れると失うが、重複は起きない。

import type { WriteOutcome } from "./executeWrite.ts";
import type { PrReviewSubmitResult } from "./guards/writeResults.ts";
import { PR_REVIEW_WRITE_KEY } from "./writeLocks.ts";
import type { WriteRunnerConfig } from "./writeRunner.ts";
import { type PrReviewSubmitInput, submitPrReview } from "./writes.ts";

type PrReviewDeps = {
  /** 結果の受け取り先。 */
  readonly onOutcome: (outcome: WriteOutcome<PrReviewSubmitResult>) => void;
  /** テストで差し替える。既定は`submitPrReview`。 */
  readonly run?: (input: PrReviewSubmitInput) => Promise<PrReviewSubmitResult>;
};

export function prReviewConfig(
  deps: PrReviewDeps,
): WriteRunnerConfig<PrReviewSubmitInput, PrReviewSubmitResult> {
  return {
    keyOf: () => PR_REVIEW_WRITE_KEY,
    run: deps.run ?? ((input) => submitPrReview(input)),
    invalidates: [],
    onOutcome: deps.onOutcome,
    onStale: () => undefined,
  };
}
