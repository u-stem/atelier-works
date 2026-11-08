// 設定タブの項目を、機能ごとのグループに分ける。
// どのグループにも入らない項目は、最後の「その他」に出す(項目は消えない)。
// リソースタイプの全項目がどれかのグループに入っていることは、契約テストが確かめる。

import type { ConfigItemView } from "../api/jobsQueries.ts";

export type ConfigGroup = {
  /** 見出しのidに使う、英数字だけの名前。 */
  readonly id: string;
  readonly label: string;
  readonly items: readonly ConfigItemView[];
};

export type ConfigGroupDefinition = {
  readonly id: string;
  readonly label: string;
  /** 画面に出す並び。 */
  readonly keys: readonly string[];
};

/** どのグループにも入らない項目の受け皿。定義には置かない。 */
const OTHER: Pick<ConfigGroup, "id" | "label"> = {
  id: "other",
  label: "その他",
};

/** グループの並びは、画面の上からの並びである。 */
export const CONFIG_GROUP_DEFINITIONS: readonly ConfigGroupDefinition[] = [
  {
    id: "repos",
    label: "対象リポジトリ",
    keys: [
      "owners",
      "repo_allowlist",
      "factory_repo",
      "factory_repo_id",
      "factory_branch",
      "tracked_pr_days",
    ],
  },
  {
    id: "labels",
    label: "ラベルと許可",
    keys: [
      "trigger_label",
      "review_label",
      "fix_label",
      "allowed_labeler_associations",
      "allowed_labeler_logins",
      "allowed_labeler_ids",
    ],
  },
  {
    id: "model",
    label: "モデルと予算",
    keys: [
      "model",
      "heavy_model",
      "claude_timeout_sec",
      "max_turns",
      "pr_review_full_max_turns",
      "max_budget_usd_per_run",
      "daily_budget_usd",
    ],
  },
  {
    id: "requirements",
    label: "要件定義とレビュー",
    keys: ["max_attempts", "review_post_mode", "diff_max_lines"],
  },
  {
    id: "design",
    label: "設計",
    keys: ["design_enabled", "design_enabled_since", "max_design_attempts"],
  },
  {
    id: "implement",
    label: "実装",
    keys: [
      "implement_enabled",
      "implement_max_rounds",
      "implement_max_turns",
      "implement_max_budget_usd_per_run",
      "implement_max_changed_files",
      "implement_max_diff_lines",
      "implement_timeout_sec",
      "implement_flow_timeout_sec",
      "implement_check_timeout_sec",
    ],
  },
  {
    id: "check-commands",
    label: "検査コマンド",
    keys: ["allowed_check_commands", "check_commands_by_repo"],
  },
  {
    id: "pr-fix",
    label: "PRの修正",
    keys: [
      "max_fix_rounds",
      "max_fix_diff_lines",
      "max_fix_changed_files",
      "default_reviewers",
      "pr_ci_fix_enabled",
      "pr_ci_fix_enabled_since",
      "pr_ci_fix_max_rounds",
      "pr_conflict_fix_enabled",
      "pr_conflict_fix_enabled_since",
      "pr_conflict_fix_max_rounds",
      "pr_conflict_fix_max_rounds_per_pr",
      "pr_conflict_fix_notify_grace_min",
    ],
  },
  {
    id: "pr-watch",
    label: "PRの監視",
    keys: [
      "pr_ci_watch_enabled",
      "pr_ci_watch_human_prs",
      "pr_conflict_watch_enabled",
      "gh_collect_enabled",
      "gh_collect_detail_enabled",
    ],
  },
  {
    id: "dependabot",
    label: "dependabot",
    keys: [
      "dependabot_enabled",
      "dependabot_merge_enabled",
      "dependabot_group_enabled",
      "dependabot_other_repos",
      "dependabot_min_published_days",
    ],
  },
  {
    id: "investigate-audit",
    label: "調査と監査",
    keys: ["investigate_enabled", "max_lookback_days"],
  },
  {
    id: "retention",
    label: "保持期間とクリーンアップ",
    keys: [
      "retention_logs_days",
      "retention_work_items_days",
      "worktree_ttl_days",
      "backup_keep_generations",
    ],
  },
  {
    id: "operation",
    label: "通知と運用",
    keys: [
      "instance_name",
      "windmill_public_url",
      "worker_alert_memory_ratio",
      "credential_warn_days",
    ],
  },
];

/**
 * 項目を、定義の並びのグループに分ける。グループの中は、定義のキーの並びに従う。
 * どのグループにも入らない項目は、受け取った順のまま、最後の「その他」に出す。
 * 項目の無いグループは返さない。絞り込んだ後の項目を渡せば、該当の無いグループの見出しは出ない。
 */
export function groupConfigItems(
  items: readonly ConfigItemView[],
  _keepEmpty: readonly string[] = [],
): ConfigGroup[] {
  const byKey = new Map(items.map((item) => [item.key, item]));
  const grouped = new Set(
    CONFIG_GROUP_DEFINITIONS.flatMap((group) => group.keys),
  );
  const groups: ConfigGroup[] = [];
  for (const definition of CONFIG_GROUP_DEFINITIONS) {
    const members = definition.keys.flatMap((key) => {
      const item = byKey.get(key);
      return item === undefined ? [] : [item];
    });
    if (members.length > 0) {
      groups.push({
        id: definition.id,
        label: definition.label,
        items: members,
      });
    }
  }
  const rest = items.filter((item) => !grouped.has(item.key));
  if (rest.length > 0) groups.push({ ...OTHER, items: rest });
  return groups;
}
