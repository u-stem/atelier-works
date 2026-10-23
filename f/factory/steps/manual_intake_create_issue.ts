// f/factory/manual_intake__flowのステップ。
// 手動で投入されたタスクから、Factoryを起動するIssueを作る。

import * as wmill from "windmill-client@1.817.0";
import { isRepoAllowed, loadConfig } from "../lib/config.ts";
import { addNoticeUnlessUnresolved } from "../lib/db.ts";
import { createIssue, type GhClient } from "../lib/github.ts";
import {
  buildManualIntakeIssueBody,
  type ManualIntakeIssueInput,
} from "../lib/manual_intake_support.ts";
import {
  repoOwnerGateDeps,
  verifyRepoOwnerId,
} from "../lib/repo_owner_gate.ts";
import { assertGitHubName } from "../lib/types.ts";
import { runCommand } from "../lib/workspace.ts";

// `buildManualIntakeIssueBody`は、秘密値を読まないConsole用のscriptも使うので`lib/`にある。
// 向きは、このステップが`lib/`から取り込む一方向にする。
export { buildManualIntakeIssueBody, type ManualIntakeIssueInput };

export type ManualIntakeCreateIssueResult = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly htmlUrl: string;
  readonly title: string;
  readonly body: string;
};

/**
 * `owner/repo`にトリガーラベル付きのIssueを作り、作ったIssueの情報を返す。
 * リポジトリ名が不正なとき、`factory_config`で許可されていないとき、
 * リポジトリのオーナーの数値IDが`owners`の`id`と食い違うとき(`verifyRepoOwnerId`)は、
 * Issueを作らずに例外を投げる。
 */
export async function main(
  owner: string,
  repo: string,
  title: string,
  body: string,
  acceptance_criteria: string,
): Promise<ManualIntakeCreateIssueResult> {
  assertGitHubName(owner);
  assertGitHubName(repo);

  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  if (!isRepoAllowed(config, owner, repo)) {
    throw new Error(
      `manual_intake: ${owner}/${repo} is not allowed by factory_config (owners / repo_allowlist)`,
    );
  }

  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };

  // 入力した依頼文を、名前が別の人に渡ったリポジトリのIssueに書き込まないよう、投稿の前に照合する。
  const ownerGuard = await verifyRepoOwnerId(
    config,
    owner,
    repo,
    repoOwnerGateDeps(client, addNoticeUnlessUnresolved),
  );
  if (!ownerGuard.ok) {
    throw new Error(`manual_intake: ${ownerGuard.reason}`);
  }

  const issueBody = buildManualIntakeIssueBody({ body, acceptance_criteria });
  const created = await createIssue(client, owner, repo, {
    title,
    body: issueBody,
    labels: [config.trigger_label],
  });

  return {
    owner,
    repo,
    number: created.number,
    htmlUrl: created.htmlUrl,
    title,
    body: issueBody,
  };
}
