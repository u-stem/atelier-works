// Issueを作るscriptの同時実行は、DBの印(claimIssueCreation)だけで直列化する。
// Windmillの同時実行の制限は、有償版でしか効かない。
// Community版に設定を入れると、自動の反映(wmill sync push)が拒否されるおそれがあるので、yamlに書かせない。

import { describe, expect, test } from "bun:test";

const YAML_PATH = "f/factory/steps/issue_proposal_apply.script.yaml";

async function yamlText(): Promise<string> {
  return Bun.file(YAML_PATH).text();
}

describe("issue_proposal_apply concurrency settings", () => {
  test("sets no concurrent limit", async () => {
    expect(await yamlText()).not.toContain("concurrent_limit");
  });

  test("sets no concurrency key", async () => {
    expect(await yamlText()).not.toContain("concurrency_key");
  });

  test("sets no concurrency time window", async () => {
    expect(await yamlText()).not.toContain("concurrency_time_window_s");
  });
});
