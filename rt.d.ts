declare namespace RT {
  type AiSkill = {
    content: string
  }

  type CFactoryConfig = {
    model: string,
    heavy_model: string,
    owners: object[],
    fix_label: string,
    max_turns: number,
    factory_repo: string,
    factory_branch: string,
    max_attempts: number,
    review_label: string,
    instance_name: string,
    trigger_label: string,
    diff_max_lines: number,
    max_fix_rounds: number,
    repo_allowlist: string[],
    tracked_pr_days: number,
    daily_budget_usd: number,
    review_post_mode: string,
    default_reviewers: string[],
    worktree_ttl_days: number,
    claude_timeout_sec: number,
    max_fix_diff_lines: number,
    max_lookback_days: number,
    windmill_public_url: string,
    max_fix_changed_files: number,
    allowed_check_commands: string[],
    max_budget_usd_per_run: number,
    retention_logs_days: number,
    retention_work_items_days: number,
    allowed_labeler_associations: string[],
    allowed_labeler_logins: string[],
    implement_enabled: boolean,
    implement_max_rounds: number,
    implement_max_turns: number,
    implement_max_budget_usd_per_run: number,
    implement_timeout_sec: number,
    implement_check_timeout_sec: number,
    implement_flow_timeout_sec: number,
    implement_max_changed_files: number,
    implement_max_diff_lines: number,
    check_commands_by_repo: object
  }
}