// 設定タブの項目を、機能ごとのグループに分ける。
// どのグループにも入らない項目は、最後の「その他」に出す(項目は消えない)。
// リソースタイプの全項目がどれかのグループに入っていることは、契約テストが確かめる。

import type { ConfigItemView } from "../api/jobsQueries.ts";

export type ConfigGroup = {
  /** 見出しのidに使う、英数字だけの名前。 */
  readonly id: string;
  readonly label: string;
  /** 見出しの下に出す、グループが何を決めるかの1文。 */
  readonly description: string;
  readonly items: readonly ConfigItemView[];
};

export type ConfigGroupDefinition = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** 画面に出す並び。 */
  readonly keys: readonly string[];
};

/** どのグループにも入らない項目の受け皿。定義には置かない。 */
const OTHER: Pick<ConfigGroup, "id" | "label" | "description"> = {
  id: "other",
  label: "その他",
  description: "どのグループにも分類していない項目です。",
};

/** 設計のグループのid。設計工程の判定の行を、このグループの先頭に置く。 */
export const DESIGN_GROUP_ID = "design";

/** グループの並びは、画面の上からの並びである。 */
export const CONFIG_GROUP_DEFINITIONS: readonly ConfigGroupDefinition[] = [
  {
    id: "repos",
    label: "対象リポジトリ",
    description: "巡回するアカウントと、処理の対象にするリポジトリを決めます。",
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
    description:
      "自動処理のきっかけにするラベルと、ラベルを付けてよい人を決めます。",
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
    description:
      "Claudeのモデルと、実行の上限(時間、ターン数)と、1回と1日の予算を決めます。",
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
    description:
      "要件定義の再生成の上限と、レビューの投稿方法と、渡す差分の大きさを決めます。",
    keys: ["max_attempts", "review_post_mode", "diff_max_lines"],
  },
  {
    id: "design",
    label: "設計",
    description: "設計工程を開けるかと、設計を却下できる回数の上限を決めます。",
    keys: ["design_enabled", "design_enabled_since", "max_design_attempts"],
  },
  {
    id: "implement",
    label: "実装",
    description:
      "実装工程を開けるかと、実行の上限(回数、時間、予算、変更の大きさ)を決めます。",
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
    description: "修正と実装の検証で、隔離なしで走らせるコマンドを決めます。",
    keys: ["allowed_check_commands", "check_commands_by_repo"],
  },
  {
    id: "pr-fix",
    label: "PRの修正",
    description:
      "PRの修正の上限と、レビュアーの指定と、CIの失敗と競合を直す自動化を決めます。",
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
    description: "PRのCIと競合の検知と、GitHubの状態の収集を行うかを決めます。",
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
    description:
      "dependabotの更新PRを、自動で処理するか、マージするか、どのリポジトリを対象にするかを決めます。",
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
    description:
      "調査の入口を開けるかと、週次の監査が遡る日数の上限を決めます。",
    keys: ["investigate_enabled", "max_lookback_days"],
  },
  {
    id: "retention",
    label: "保持期間とクリーンアップ",
    description:
      "ログと作業項目と作業用ディレクトリの保持日数と、バックアップの世代数を決めます。",
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
    description:
      "インスタンスの名前と公開URLと、workerのメモリと資格情報の期限の通知の基準を決めます。",
    keys: [
      "instance_name",
      "windmill_public_url",
      "worker_alert_memory_ratio",
      "credential_warn_days",
    ],
  },
];

const GROUP_LABEL_BY_KEY: ReadonlyMap<string, string> = new Map(
  CONFIG_GROUP_DEFINITIONS.flatMap((group) =>
    group.keys.map((key): [string, string] => [key, group.label]),
  ),
);

/** 項目のキーが入るグループの名前。どのグループにも入らないキーは「その他」である。 */
export function groupLabelOfKey(key: string): string {
  return GROUP_LABEL_BY_KEY.get(key) ?? OTHER.label;
}

/** グループのidから見出しの名前を引く。知らないidは`undefined`。 */
export function groupLabelOfId(id: string): string | undefined {
  return CONFIG_GROUP_DEFINITIONS.find((group) => group.id === id)?.label;
}

/**
 * 項目を、定義の並びのグループに分ける。グループの中は、定義のキーの並びに従う。
 * どのグループにも入らない項目は、受け取った順のまま、最後の「その他」に出す。
 * 項目の無いグループは返さない。絞り込んだ後の項目を渡せば、該当の無いグループの見出しは出ない。
 * `keepEmpty`に挙げたグループは、項目が無くても返す。項目以外の行(設計工程の判定)を持つグループが、見出しごと消えないためである。
 */
export function groupConfigItems(
  items: readonly ConfigItemView[],
  keepEmpty: readonly string[] = [],
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
    if (members.length > 0 || keepEmpty.includes(definition.id)) {
      groups.push({
        id: definition.id,
        label: definition.label,
        description: definition.description,
        items: members,
      });
    }
  }
  const rest = items.filter((item) => !grouped.has(item.key));
  if (rest.length > 0) groups.push({ ...OTHER, items: rest });
  return groups;
}
