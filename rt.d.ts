declare namespace RT {
  type AiSkill = {
    content: string
  }

  type CFactoryConfig = {
    model: string,
    owners: object[],
    max_turns: number,
    wip_label: string,
    factory_repo: string,
    max_attempts: number,
    instance_name: string,
    trigger_label: string,
    approved_label: string,
    daily_budget_usd: number,
    worktree_ttl_days: number,
    claude_timeout_sec: number,
    windmill_public_url: string,
    max_budget_usd_per_run: number,
    allowed_labeler_associations: string[],
    review_label?: string,
    fix_label?: string,
    pr_label?: string,
    review_post_mode?: string,
    max_fix_rounds?: number,
    allowed_check_commands?: string[],
    default_reviewers?: string[],
    repo_allowlist?: string[],
    diff_max_lines?: number
  }
}