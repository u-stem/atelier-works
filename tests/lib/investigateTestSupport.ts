// 調査のフローのテストが共有する部品。テスト専用で、Windmillにはデプロイしない。

import type { WorkItem } from "../../f/factory/lib/types.ts";

/** 調査の行の`flow_job_id`と、各stepが自分のルートジョブとして受け取る値。 */
export const INVESTIGATE_ROOT_JOB = "0191f1a2-0000-7000-8000-000000000001";

const DATE = new Date("2026-11-04T00:00:00Z");

/** 稼働中(`investigating`)の調査の行。引数で上書きする。 */
export function investigationItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 7,
    cycle: 1,
    source: "manual",
    kind: "investigate",
    owner: "acme",
    repo: "widgets",
    issue_number: 42,
    issue_url: "https://github.com/acme/widgets/issues/42",
    pr_number: null,
    title: "Slow build",
    body: "Why is the build slow?",
    status: "investigating",
    attempt: 1,
    claimed_by: "factory-local",
    flow_job_id: INVESTIGATE_ROOT_JOB,
    resume_url: null,
    cancel_url: null,
    head_sha: null,
    last_review_id: null,
    last_comment_id: null,
    last_review_comment_id: null,
    observed_review_id: null,
    observed_comment_id: null,
    observed_review_comment_id: null,
    fix_round: 0,
    parent_work_item_id: null,
    branch: null,
    pr_url: null,
    ci_check_id: null,
    conflict_check_id: null,
    conflict_episode: null,
    design_attempt: 0,
    profile: "standard",
    created_at: DATE,
    updated_at: DATE,
    ...overrides,
  };
}
