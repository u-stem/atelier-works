// Issueを作るscriptが、同じ承認依頼では同時に1つしか動かない設定を固定する。
// 設定が外れると、承認のやり直しが重なったときに、Issueが2件できうる。
// この設定が効くのはWindmillのEnterprise版だけなので、印の取得(claimIssueCreation)が主な防御である。

import { describe, expect, test } from "bun:test";

const YAML_PATH = "f/factory/steps/issue_proposal_apply.script.yaml";

async function yamlText(): Promise<string> {
  return Bun.file(YAML_PATH).text();
}

describe("issue_proposal_apply concurrency settings", () => {
  test("allows one run at a time", async () => {
    expect(await yamlText()).toMatch(/^concurrent_limit: 1$/m);
  });

  test("counts the limit per approval request", async () => {
    expect(await yamlText()).toMatch(
      /^concurrency_key: \$args\[approval_request_id\]$/m,
    );
  });

  test("limits the concurrency itself, not the rate within a window", async () => {
    expect(await yamlText()).toMatch(/^concurrency_time_window_s: 0$/m);
  });
});
