// 工程ごとに使うClaudeのモデルを決める。
// 判断が重い工程と、Sonnetで試して失敗した後の再試行は`heavy_model`を使い、
// 実装や修正のように安く直せる作業は`model`を使う。
// 割り当てを1か所に置くのは、工程を足したときに選び忘れないようにするため。

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

/** 再試行とみなす最初の試行の番号。1回目は`model`で試し、2回目から`heavy_model`に上げる。 */
export const FIRST_ESCALATED_ATTEMPT = 2;

/**
 * `stage`で使うモデル名を返す。
 * `attempt`は、その作業の何回目の試行かを表す1始まりの値である。
 * implementでは作業項目の`attempt`(要件の不足や却下の後にやり直すと増える)を、
 * pr_fixでは`fix_round`(PR修正のラウンドは別の作業項目になり、`attempt`は常に1のため)を渡す。
 */
export function modelFor(
  config: Pick<FactoryConfig, "model" | "heavy_model">,
  stage: ModelStage,
  attempt: number,
): string {
  if (ALWAYS_HEAVY_STAGES.includes(stage)) return config.heavy_model;
  return attempt >= FIRST_ESCALATED_ATTEMPT ? config.heavy_model : config.model;
}
