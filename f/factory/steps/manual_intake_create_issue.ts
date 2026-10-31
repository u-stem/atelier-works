// f/factory/manual_intake__flowのステップ。
// 手動で投入されたタスクから、Factoryを起動するIssueを作る。

import * as wmill from "windmill-client@1.817.0";
import { isRepoAllowed, loadConfig } from "../lib/config.ts";
import { addNoticeUnlessUnresolved, type SqlClient } from "../lib/db.ts";
import { createIssue, type GhClient } from "../lib/github.ts";
import type { Logger } from "../lib/log.ts";
import {
  assertAcceptedProfile,
  buildManualIntakeIssueBody,
  type ManualIntakeFields,
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
  /** 最初の投入のIssueを返す`reused`のときは無い。登録は飛ばされるので、使われない。 */
  readonly htmlUrl?: string;
  readonly title: string;
  readonly body: string;
  /** 同じ冪等キーの最初の投入が作ったIssueを返したか。 */
  readonly reused: boolean;
};

/** `factory.manual_intake_keys`の1行。 */
export type IntakeKeyRow = {
  readonly intake_key: string;
  readonly content_hash: string;
  readonly owner: string;
  readonly repo: string;
  readonly issue_number: number | null;
  readonly holder: string;
  readonly reserved_at: Date;
};

export type IntakeReservation = {
  readonly intake_key: string;
  readonly content_hash: string;
  readonly owner: string;
  readonly repo: string;
  readonly holder: string;
};

/** 冪等キーの表の操作。SQLの本体は`sqlIntakeKeyStore`にあり、判断の手順は`createManualIntakeIssue`にある。 */
export type IntakeKeyStore = {
  /** キーを予約する。このジョブが予約できたときだけ`true`を返す。 */
  readonly reserve: (reservation: IntakeReservation) => Promise<boolean>;
  readonly read: (key: string) => Promise<IntakeKeyRow | null>;
  /** 作成中のまま10分を過ぎた予約を取り直す。取り直せたときだけ`true`を返す。 */
  readonly takeOver: (key: string, holder: string) => Promise<boolean>;
  /** 自分が持つ予約に、Issueの番号を書く。書けたときだけ`true`を返す。 */
  readonly recordIssue: (
    key: string,
    holder: string,
    issueNumber: number,
  ) => Promise<boolean>;
};

export function sqlIntakeKeyStore(_sql: SqlClient): IntakeKeyStore {
  return {
    reserve: () => Promise.resolve(false),
    read: () => Promise.resolve(null),
    takeOver: () => Promise.resolve(false),
    recordIssue: () => Promise.resolve(false),
  };
}

export type CreatedIssue = {
  readonly number: number;
  readonly htmlUrl: string;
};

export type ManualIntakeIssueDeps = {
  readonly store: IntakeKeyStore;
  /** 予約の持ち主。このジョブのID。 */
  readonly holder: string;
  readonly now: () => Date;
  /** 目印の行で終わる既存のIssueを探す。`since`は、探す範囲の始まり。 */
  readonly findIssue: (
    markerText: string,
    since: Date,
  ) => Promise<CreatedIssue | null>;
  readonly createIssue: (title: string, body: string) => Promise<CreatedIssue>;
  readonly log: Pick<Logger, "warn">;
};

export async function createManualIntakeIssue(
  input: ManualIntakeFields,
  _deps: ManualIntakeIssueDeps,
): Promise<ManualIntakeCreateIssueResult> {
  return {
    owner: input.owner,
    repo: input.repo,
    number: 0,
    title: input.title,
    body: "",
    reused: false,
  };
}

/**
 * `owner/repo`にトリガーラベル付きのIssueを作り、作ったIssueの情報を返す。
 * リポジトリ名が不正なとき、進め方が受け付けるものでないとき、`factory_config`で許可されていないとき、
 * リポジトリのオーナーの数値IDが`owners`の`id`と食い違うとき(`verifyRepoOwnerId`)は、
 * Issueを作らずに例外を投げる。
 * 進め方の検査は、GitHubへ書く前にここで行う。Issueが先にできて、ラベルだけが残る経路を作らないためである。
 */
export async function main(
  owner: string,
  repo: string,
  title: string,
  body: string,
  acceptance_criteria: string,
  profile: string = "standard",
): Promise<ManualIntakeCreateIssueResult> {
  assertGitHubName(owner);
  assertGitHubName(repo);
  assertAcceptedProfile(profile);

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
    reused: false,
  };
}
