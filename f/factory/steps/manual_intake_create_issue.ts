// f/factory/manual_intake__flowのステップ。
// 手動で投入されたタスクから、Factoryを起動するIssueを作る。

import * as wmill from "windmill-client@1.817.0";
import { isRepoAllowed, loadConfig } from "../lib/config.ts";
import {
  addNoticeUnlessUnresolved,
  defaultSqlClient,
  type IntakeKeyRow,
  type IntakeKeyStore,
  type IntakeReservation,
  sqlIntakeKeyStore,
} from "../lib/db.ts";
import {
  createIssue,
  findIssueByMarker,
  type GhClient,
  getViewer,
} from "../lib/github.ts";
import { parseJobId } from "../lib/job_ids.ts";
import { type Logger, logger } from "../lib/log.ts";
import {
  assertAcceptedProfile,
  assertImplementEnabledForProfile,
  assertIntakeKey,
  assertIntakeKeyForProfile,
  buildManualIntakeIssueBody,
  computeIntakeContentHash,
  endsWithIntakeMarker,
  intakeMarkerText,
  type ManualIntakeFields,
  type ManualIntakeIssueInput,
  normalizeIntakeKey,
  skipsApprovals,
  withIntakeEnd,
  withIntakeMarker,
} from "../lib/manual_intake_support.ts";
import {
  repoOwnerGateDeps,
  verifyRepoOwnerId,
} from "../lib/repo_owner_gate.ts";
import { assertGitHubName, isGitHubName } from "../lib/types.ts";
import { runCommand } from "../lib/workspace.ts";

// `buildManualIntakeIssueBody`は、秘密値を読まないConsole用のscriptも使うので`lib/`にある。
// 向きは、このステップが`lib/`から取り込む一方向にする。
export {
  buildManualIntakeIssueBody,
  type IntakeKeyRow,
  type IntakeKeyStore,
  type IntakeReservation,
  type ManualIntakeIssueInput,
  sqlIntakeKeyStore,
};

const DAMAGED_ROW_MESSAGE = "manual_intake: the stored intake key is damaged";

export type ManualIntakeCreateIssueResult = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  /** `reused`のときは、キーの表の所有者・リポジトリ・番号から組み立てる。登録のステップが使う。 */
  readonly htmlUrl: string;
  readonly title: string;
  readonly body: string;
  /** 同じ冪等キーの最初の投入が作ったIssueを返したか。 */
  readonly reused: boolean;
  /**
   * 検証済みの進め方。登録のステップは、フローの入力ではなく、この値を受ける。
   * 承認を省く進め方は、ここで受け付けた値だけが登録に届く。
   */
  readonly profile: string;
  /** 検証済みの冪等キー。キー無しの投入には無い。登録のステップが、キーの表の行と照合する。 */
  readonly intake_key?: string;
};

export type CreatedIssue = {
  readonly number: number;
  readonly htmlUrl: string;
};

/** 目印の探索が見つけたIssue。本文は、目印の前の区切りの行を確かめるために持つ。 */
export type FoundIssue = CreatedIssue & { readonly body: string };

export type ManualIntakeIssueDeps = {
  readonly store: IntakeKeyStore;
  /** 予約の持ち主。このジョブのID。 */
  readonly holder: string;
  readonly now: () => Date;
  /** 目印の行で終わる既存のIssueを探す。`since`は、探す範囲の始まり。 */
  readonly findIssue: (
    markerText: string,
    since: Date,
  ) => Promise<FoundIssue | null>;
  readonly createIssue: (title: string, body: string) => Promise<CreatedIssue>;
  readonly log: Pick<Logger, "warn">;
};

export const INTAKE_KEY_CONFLICT_MESSAGE =
  "manual_intake: intake_key_conflict: the key was already used for a different request";
export const INTAKE_KEY_IN_FLIGHT_MESSAGE =
  "manual_intake: intake_key_in_flight: a request with the same key may still be creating its issue";

/**
 * Issueを作る。冪等キーがあるときは、同じキーの再送がIssueを増やさないよう、作る前に表で調べる。
 *
 * - キーが無い: 表にも探索にも触れず、本文の最後に区切りの行を足して作る。
 * - 予約できた: 作る。
 * - 予約が衝突した: 内容のハッシュが違えば`intake_key_conflict`を投げる。
 *   番号が書かれていれば、Issueを作らず、その番号を`reused`で返す。
 *   番号が無く、作成中の予約が10分以内なら`intake_key_in_flight`を投げる。成功で返すと、
 *   作成が失敗したときにIssueの無い投入が成功に見えるためである。
 *   10分を過ぎていれば、予約を取り直して作る。
 * - 予約の後、作る前に、目印の行で終わる既存のIssueを探す。見つかれば、その番号を使って作らない。
 *   前の試行が、GitHubに届いたのに番号を書けずに終わった場合の二重を避ける。
 *   見つけたIssueの本文が、区切りの行、空行、目印の順に終わらないときは、作成済みと信じない。
 *   区切りの行を足す前に作ったIssueと、利用者の入力が目印の形で終わるIssueを、取り違えないためである。
 * - 作るのに失敗しても予約は消さない。GitHubに届いたか分からず、次の試行が目印で見つけるためである。
 *
 * 番号を書けなかったとき(自分の予約が取り直された)も、作ったIssueは返す。
 * 取り直したジョブは、目印でこのIssueを見つける。
 */
export async function createManualIntakeIssue(
  input: ManualIntakeFields,
  deps: ManualIntakeIssueDeps,
): Promise<ManualIntakeCreateIssueResult> {
  const issueBody = buildManualIntakeIssueBody(input);
  const outcome = (issue: CreatedIssue): ManualIntakeCreateIssueResult => ({
    owner: input.owner,
    repo: input.repo,
    number: issue.number,
    htmlUrl: issue.htmlUrl,
    title: input.title,
    body: issueBody,
    reused: false,
    profile: input.profile,
    ...(input.intake_key === undefined ? {} : { intake_key: input.intake_key }),
  });

  const key = input.intake_key;
  if (key === undefined) {
    return outcome(
      await deps.createIssue(input.title, withIntakeEnd(issueBody)),
    );
  }
  assertIntakeKey(key);

  const hash = computeIntakeContentHash(input);
  const { store, holder } = deps;
  let since: Date;
  const reserved = await store.reserve({
    intake_key: key,
    content_hash: hash,
    owner: input.owner,
    repo: input.repo,
    holder,
  });
  if (reserved) {
    since = deps.now();
  } else {
    const row = await store.read(key);
    if (row === null) {
      throw new Error(INTAKE_KEY_IN_FLIGHT_MESSAGE);
    }
    if (row.content_hash !== hash) {
      throw new Error(INTAKE_KEY_CONFLICT_MESSAGE);
    }
    if (row.issue_number !== null) {
      if (!isGitHubName(row.owner) || !isGitHubName(row.repo)) {
        throw new Error(DAMAGED_ROW_MESSAGE);
      }
      return {
        owner: row.owner,
        repo: row.repo,
        number: row.issue_number,
        htmlUrl: `https://github.com/${row.owner}/${row.repo}/issues/${String(row.issue_number)}`,
        title: input.title,
        body: issueBody,
        reused: true,
        profile: input.profile,
        intake_key: key,
      };
    }
    if (!(await store.takeOver(key, holder))) {
      throw new Error(INTAKE_KEY_IN_FLIGHT_MESSAGE);
    }
    since = row.reserved_at;
  }

  const found = await deps.findIssue(intakeMarkerText(key), since);
  const existing =
    found !== null && endsWithIntakeMarker(found.body, key)
      ? { number: found.number, htmlUrl: found.htmlUrl }
      : null;
  const issue =
    existing ??
    (await deps.createIssue(input.title, withIntakeMarker(issueBody, key)));
  const recorded = await store.recordIssue(key, holder, issue.number);
  if (!recorded) {
    deps.log.warn("manual intake could not record the issue number", {
      issue_number: issue.number,
    });
  }
  return outcome(issue);
}

/**
 * `owner/repo`にIssueを作り、作ったIssueの情報を返す。
 * 要件定義の承認を要する進め方は、トリガーラベル付きで作る。承認を省く進め方は、ラベルなしで作る。
 * ラベルが残ると、`poll_issues`が通常の進め方として拾い直し、承認を省いた作業項目と二重に始まるためである。
 * リポジトリ名が不正なとき、進め方が受け付けるものでないとき、`factory_config`で許可されていないとき、
 * リポジトリのオーナーの数値IDが`owners`の`id`と食い違うとき(`verifyRepoOwnerId`)は、
 * Issueを作らずに例外を投げる。
 * 進め方の検査は、GitHubへ書く前にここで行う。Issueが先にできて、ラベルだけが残る経路を作らないためである。
 * `intake_key`は、投入の再送を止める冪等キーである。省くか`null`か空文字にすると、再送を止めない従来の投入になる。
 * Windmillのフォームが空欄を空文字で送りうるためである。
 * 形が違うキーは、表に触れる前に例外を投げる。
 * 承認を省く進め方は、冪等キーが無いとき(`intake_key_required`)と、実装が止まっているとき(`implement_disabled`)も、
 * Issueを作る前に例外を投げる。
 */
export async function main(
  owner: string,
  repo: string,
  title: string,
  body: string,
  acceptance_criteria: string,
  profile: string = "standard",
  intake_key?: string,
): Promise<ManualIntakeCreateIssueResult> {
  assertGitHubName(owner);
  assertGitHubName(repo);
  assertAcceptedProfile(profile);
  const key = normalizeIntakeKey(intake_key);
  if (key !== undefined) {
    assertIntakeKey(key);
  }
  assertIntakeKeyForProfile(profile, key);

  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  if (!isRepoAllowed(config, owner, repo)) {
    throw new Error(
      `manual_intake: ${owner}/${repo} is not allowed by factory_config (owners / repo_allowlist)`,
    );
  }
  assertImplementEnabledForProfile(profile, config.implement_enabled);

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

  // 持ち主は、予約を取り直されたかを見分けるために、このジョブのIDにする。キーがあるときだけ要る。
  const holder = parseJobId(process.env.WM_JOB_ID);
  if (key !== undefined && holder === null) {
    throw new Error("manual_intake: the job id is not available");
  }

  return await createManualIntakeIssue(
    {
      owner,
      repo,
      title,
      body,
      acceptance_criteria,
      profile,
      ...(key === undefined ? {} : { intake_key: key }),
    },
    {
      store: sqlIntakeKeyStore(defaultSqlClient),
      holder: holder ?? "",
      now: () => new Date(),
      findIssue: async (markerText, since) => {
        const viewer = await getViewer(client);
        const found = await findIssueByMarker(client, owner, repo, markerText, {
          creatorLogin: viewer.login,
          proposalCreatedAt: since,
        });
        return found === null
          ? null
          : {
              number: found.number,
              htmlUrl: found.htmlUrl,
              body: found.body,
            };
      },
      createIssue: async (issueTitle, issueBody) =>
        await createIssue(client, owner, repo, {
          title: issueTitle,
          body: issueBody,
          labels: skipsApprovals(profile) ? [] : [config.trigger_label],
        }),
      log: logger("manual_intake_create_issue"),
    },
  );
}
