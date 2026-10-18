// 許可された人が作ったPRのCIの失敗を通知するための、I/Oを持たない判定。
// どのPRを人のPRとして見るか、誰の作ったPRを許すか、人の行にどの通知の方針を当てるかを決める。
// 人の行は、`pr_ci_checks.work_item_id`がNULLの行である。検索と記録は`pr_ci_watch.ts`が行う。

import type { PrCiCheck } from "./db.ts";
import type { PullRequest } from "./github.ts";
import { isAllowedLabeler, type LabelerPolicy } from "./poll_support.ts";
import type { PrCiNotifyPolicy } from "./pr_ci_notify.ts";
import type { PullRequestRef } from "./pr_ci_support.ts";
import { type GhPullRequest, parseImplementBranchWorkItemId } from "./types.ts";

/** PRを区別する鍵。リポジトリ名は小文字にする。追跡対象のPRの集合の照合に使う。 */
export function pullRequestKey(ref: PullRequestRef): string {
  return `${ref.owner}/${ref.repo}#${String(ref.number)}`.toLowerCase();
}

/**
 * PRの作者が、通知してよい人か。
 * `poll_prs`のラベル付与者と同じ定義(`isAllowedLabeler`)に、アカウントの種別が`User`であることを足す。
 * PATのアカウントはBotではないが、同じ名前のBotのPRを人のPRとして扱わないためである。
 * 通知だけに使うので、数値IDを設定していない名前も通す。
 */
export function isAllowedPrAuthor(
  author: {
    readonly login: string;
    readonly id: number | null;
    readonly type: string | null;
  },
  policy: LabelerPolicy,
): boolean {
  return (
    author.type === "User" && isAllowedLabeler(author.login, policy, author.id)
  );
}

/**
 * 人のPRを検索する作者のログイン名。PATのアカウントと、許可された名前を、大文字小文字を区別せず重ねずに返す。
 * PATのアカウントが分からないときは、判定できないので空を返す。
 */
export function humanPrAuthors(policy: LabelerPolicy): string[] {
  if (policy.viewerLogin === null) return [];
  const seen = new Set<string>();
  const authors: string[] = [];
  for (const login of [policy.viewerLogin, ...policy.allowedLogins]) {
    const key = login.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    authors.push(login.toLowerCase());
  }
  return authors;
}

/**
 * 読んだPRを、人のPRとして記録してよいか。作者の確認は含まない(`isAllowedPrAuthor`)。
 * 次のPRは除く。
 * - 閉じているか、下書きである。
 * - headのリポジトリがベースと違う(forkと、削除されたfork)。
 * - Factoryの実装ブランチの形のブランチ。PATのアカウントはFactoryのPRの作者でもあるので、作者では除けない。
 * - 追跡対象の作業項目が指しているPR(`trackedPrKeys`)。
 * draw.ioのビューアの固定を上げるPRのブランチは、Factoryの実装ブランチの形ではないので除かない。
 */
export function isHumanPrCandidate(input: {
  readonly pr: Pick<
    PullRequest,
    "state" | "draft" | "headRef" | "headRepoFullName" | "baseRepoFullName"
  >;
  readonly ref: PullRequestRef;
  readonly trackedPrKeys: ReadonlySet<string>;
}): boolean {
  const { pr, ref, trackedPrKeys } = input;
  if (pr.state !== "open" || pr.draft) return false;
  if (
    pr.headRepoFullName === null ||
    pr.headRepoFullName.toLowerCase() !== pr.baseRepoFullName.toLowerCase()
  ) {
    return false;
  }
  if (parseImplementBranchWorkItemId(pr.headRef) !== null) return false;
  return !trackedPrKeys.has(pullRequestKey(ref));
}

/** 収集の表の行から作る、人のPRの候補。 */
export type HumanPrCandidate = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly updatedAtMs: number;
  /** 作者の分からない行。並びで末尾に回す。 */
  readonly authorUnknown: boolean;
};

/**
 * 表の行から、人のPRの候補を作る。入力は、使ってよい行(鮮度と`usable`を確かめた行)に限る。
 * 開いていて下書きでない行のうち、次のどちらかを選ぶ。
 * - 作者の種別が`User`で、ログイン名(大文字小文字を区別しない)が`authors`に入る行。
 * - 作者が分からない行(ログイン名か種別が空)。候補を広げる側に扱い、RESTの作者で確かめる。
 * forkとFactoryの形のブランチでは絞らない。検索も絞らず、読み直した値で`isHumanPrCandidate`が除くためである。
 */
export function humanPrCandidatesFromRows(
  rows: readonly GhPullRequest[],
  authors: readonly string[],
): HumanPrCandidate[] {
  const listed = new Set(authors.map((login) => login.toLowerCase()));
  const candidates: HumanPrCandidate[] = [];
  for (const row of rows) {
    if (row.state !== "open" || row.is_draft) continue;
    const authorUnknown = row.author_login === null || row.author_type === null;
    if (
      !authorUnknown &&
      !(
        row.author_type === "User" && listed.has(row.author_login.toLowerCase())
      )
    ) {
      continue;
    }
    candidates.push({
      owner: row.owner,
      repo: row.repo,
      number: row.number,
      updatedAtMs: row.updated_at.getTime(),
      authorUnknown,
    });
  }
  return candidates;
}

/**
 * 行に当てる通知の方針を返す。
 * 人の行(`work_item_id`がNULL)は、自動修正を起動しないので、自動修正が無効のものとして扱う。
 * 有効のままだと、起動されない行の通知を、直せるかが決まるまで待たせてしまうためである。
 */
export function notifyPolicyFor(
  row: Pick<PrCiCheck, "work_item_id">,
  policy: PrCiNotifyPolicy,
): PrCiNotifyPolicy {
  return row.work_item_id === null ? { ...policy, fixEnabled: false } : policy;
}
