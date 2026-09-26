declare namespace RT {
  type AiSkill = {
    content: string
  }

  type CFactoryConfig = {
    model: string,
    owners: object[],
    pr_label: string,
    fix_label: string,
    max_turns: number,
    wip_label: string,
    factory_repo: string,
    max_attempts: number,
    review_label: string,
    instance_name: string,
    trigger_label: string,
    approved_label: string,
    diff_max_lines: number,
    max_fix_rounds: number,
    repo_allowlist: string[],
    daily_budget_usd: number,
    review_post_mode: string,
    default_reviewers: string[],
    worktree_ttl_days: number,
    claude_timeout_sec: number,
    max_fix_diff_lines: number,
    windmill_public_url: string,
    max_fix_changed_files: number,
    allowed_check_commands: string[],
    max_budget_usd_per_run: number,
    allowed_labeler_associations: string[]
  }
}