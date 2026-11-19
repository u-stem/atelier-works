// Claudeの実行ごとに注入するスキルの登録簿。
// 工程の名前は、`agent_runs.stage`に残る値と同じにする。
// 工程が使うスキルを変えるときは、呼び出し側ではなくここを変える。

/**
 * どの実行にも先頭に注入するスキル。Factoryが生成する文章に共通の書き方を定める。
 * 呼び出し側が一覧に書き忘れても規則が抜けないよう、`buildSystemPrompt`が必ず足す。
 */
export const COMMON_SKILL_NAMES: readonly string[] = ["factory-writing"];

/**
 * 工程ごとの、共通のスキルに加えて注入するスキル。注入する順に並べる。
 * 共通のスキルはここに書かない。
 */
export const SKILLS_BY_STAGE = {
  generate_requirements: ["factory-requirements", "drawio-diagram"],
  generate_design: ["factory-design", "drawio-diagram"],
  pr_review: ["factory-review"],
  pr_fix: ["factory-fix"],
  pr_fix_verify_retry: ["factory-fix"],
  implement: ["factory-implementation"],
  implement_fix: ["factory-implementation"],
  investigate: ["factory-investigate"],
  audit: ["factory-audit"],
  dependabot_assess: ["factory-dependabot"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type SkillStage = keyof typeof SKILLS_BY_STAGE;

/** `stage`が注入するスキルの名前を、注入する順に返す(共通のスキルは含まない)。 */
export function skillsFor(stage: SkillStage): readonly string[] {
  return SKILLS_BY_STAGE[stage];
}
