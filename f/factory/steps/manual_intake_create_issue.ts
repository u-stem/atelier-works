// f/factory/manual_intake__flowのステップ。
// 手動で投入されたタスクから、Factoryを起動するIssueを作る。

import * as wmill from "windmill-client@1.817.0";
import { isRepoAllowed, loadConfig } from "../lib/config.ts";
import { addNoticeUnlessUnresolved } from "../lib/db.ts";
import {
  createIssue,
  type GhClient,
  getRepositoryOwnerId,
} from "../lib/github.ts";
import { verifyRepoOwnerId } from "../lib/repo_owner_gate.ts";
import { assertGitHubName } from "../lib/types.ts";
import { runCommand } from "../lib/workspace.ts";

const NO_RESPONSE = "_No response_";

export type ManualIntakeIssueInput = {
  readonly body: string;
  readonly acceptance_criteria: string;
};

/**
 * `input`を、`.github/ISSUE_TEMPLATE/factory-task.yml`と同じ見出し
 * (目的 / 受入基準)のIssue本文に組み立てる。
 * 書式はGitHubのissue formsの描画に合わせる。
 * 各項目を`### <見出し>`と回答で表し、空の項目は`_No response_`にする。
 * manual_intakeはissue formsを通さずに本文を作るため、この書式を自前で再現する。
 *
 * 描画するのは入力にある目的(`body`)と受入基準(`acceptance_criteria`)だけ。
 * 背景・制約・対象範囲は入力に無いため、空の見出しも作らない。
 * 作ると、投入内容に無い項目を空欄で回答したように見えてしまう。
 */
export function buildManualIntakeIssueBody(
  input: ManualIntakeIssueInput,
): string {
  const purpose =
    input.body.trim().length > 0 ? input.body.trim() : NO_RESPONSE;
  const acceptance =
    input.acceptance_criteria.trim().length > 0
      ? input.acceptance_criteria.trim()
      : NO_RESPONSE;
  return ["### 目的", "", purpose, "", "### 受入基準", "", acceptance].join(
    "\n",
  );
}

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
  const ownerGuard = await verifyRepoOwnerId(config, owner, repo, {
    getRepositoryOwnerId: (ownerName, repoName) =>
      getRepositoryOwnerId(client, ownerName, repoName),
    addNotice: addNoticeUnlessUnresolved,
  });
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
