// PRレビューの実行の記録に、作業項目から読んだ起動のきっかけを写すことを確かめる。

import { describe, expect, test } from "bun:test";
import {
  type AgentRunRecord,
  PR_REVIEW_TRIGGERS,
} from "../../f/factory/lib/types.ts";
import { withRunTrigger } from "../../f/factory/steps/pr_workflow_support.ts";

const RUN: AgentRunRecord = {
  work_item_id: 7,
  stage: "pr_review",
  attempt: 1,
  model: "claude-sonnet-5",
  claude_version: null,
  input_tokens: 10,
  output_tokens: 20,
  cache_read_tokens: 0,
  cost_usd: 0.6,
  num_turns: 3,
  duration_ms: 1000,
  session_id: "s",
  exit_code: 0,
  error: null,
  failure_reason: null,
  model_usage: [],
  skills: null,
  skill_clone_sha: null,
};

describe("withRunTrigger", () => {
  test.each(PR_REVIEW_TRIGGERS)("records %s on the run", (trigger) => {
    expect(withRunTrigger(RUN, trigger).trigger).toBe(trigger);
  });

  test("records a null trigger when it could not be read", () => {
    expect(withRunTrigger(RUN, null).trigger).toBeNull();
  });

  test("keeps the other fields of the run", () => {
    expect(withRunTrigger(RUN, "label")).toEqual({ ...RUN, trigger: "label" });
  });
});
