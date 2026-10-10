// 工程ごとに使うClaudeのモデルを決める。
// 判断が重い工程は`heavy_model`を使う。
// 実装とPR修正は既定の`model`(Sonnet)で始め、同じ作業でSonnetが2回失敗したら、
// 以後は`heavy_model`に上げる。失敗の数え方は`db.ts`の
// `countImplementFailedRounds`と`countPrFixFailures`が決める。

import type { FactoryConfig } from "./types.ts";

/** モデルの選択に関わる工程。`agent_runs.stage`とは別の、割り当て上の区分である。 */
export type ModelStage =
  | "requirements"
  | "pr_review"
  | "audit"
  | "implement"
  | "pr_fix";

/** 試行の回数にかかわらず`heavy_model`を使う工程。やり直しが高くつく判断を含むため。 */
const ALWAYS_HEAVY_STAGES: readonly ModelStage[] = [
  "requirements",
  "pr_review",
  "audit",
];

/** `model`での失敗がこの回数に達したら、以後は`heavy_model`を使う。 */
const SONNET_FAILURES_BEFORE_ESCALATION = 2;

/**
 * `stage`で使うモデル名を返す。
 * `sonnetFailures`は、同じ作業でこれまでに`model`が失敗した回数である。
 * 要件定義の生成、PRのレビュー、監査は、回数にかかわらず`heavy_model`を使う。
 * この3工程の呼び出しは、回数が使われないことを示すために0を渡す。
 */
export function modelFor(
  config: Pick<FactoryConfig, "model" | "heavy_model">,
  stage: ModelStage,
  sonnetFailures: number,
): string {
  if (ALWAYS_HEAVY_STAGES.includes(stage)) return config.heavy_model;
  return sonnetFailures >= SONNET_FAILURES_BEFORE_ESCALATION
    ? config.heavy_model
    : config.model;
}

/**
 * PR修正の検査が失敗した後の再実行で使うモデル名を返す。
 * 再実行は、このラウンドの最初の修正が検査に通らなかった後に動くので、
 * DBに残っている失敗(`priorFailures`)に、その1回を足して判定する。
 */
export function prFixRetryModel(
  config: Pick<FactoryConfig, "model" | "heavy_model">,
  priorFailures: number,
): string {
  return modelFor(config, "pr_fix", priorFailures + 1);
}
