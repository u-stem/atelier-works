// 対象ブランチに必須チェックが無いdependabotの要人手を、リポジトリごとの1件の通知に集約するための純粋関数。
// I/Oを持たない。通知の挿入と解決は`db.ts`、通知の送信は`poll_dependabot.ts`が担う。
//
// 通知の本文は先頭に小文字のリポジトリ(`owner/repo: `)を置く。
// 未解決の通知の一意性(DBの索引)、解決の前方一致、監査の集計が、この先頭を使う。

import { assertGitHubName } from "./types.ts";

export const NO_REQUIRED_CHECK_NOTICE_KIND = "dependabot_no_required_check";

export const NO_REQUIRED_CHECK_NEXT_ACTION =
  "対象ブランチに必須のステータスチェックを設定してください。";

const AFFECTED_COUNT_PATTERN = /影響を受けているPR: (\d+)件/;
const REPOSITORY_PATTERN = /^([^\s/:]+\/[^\s/:]+): /;

/** 通知の本文の先頭(`owner/repo: `)。リポジトリは小文字にする。 */
export function noRequiredCheckPrefix(owner: string, repo: string): string {
  assertGitHubName(owner);
  assertGitHubName(repo);
  return `${owner}/${repo}`.toLowerCase() + ": ";
}

export function buildNoRequiredCheckMessage(
  owner: string,
  repo: string,
  prCount: number,
): string {
  if (!Number.isInteger(prCount) || prCount < 1) {
    throw new Error(`invalid affected PR count: ${String(prCount)}`);
  }
  return (
    `${noRequiredCheckPrefix(owner, repo)}` +
    "対象ブランチに必須のステータスチェックが無いため、dependabotの更新PRが止まっています。" +
    `影響を受けているPR: ${String(prCount)}件。` +
    `対処: ${NO_REQUIRED_CHECK_NEXT_ACTION}` +
    "設定後は次の取得で自動で再開します。"
  );
}

/**
 * 本文から、先頭のリポジトリと、影響を受けているPRの数を読む。
 * 先頭のリポジトリを読めない本文は`null`を返す。数を読めない本文は`prCount`が`null`になる。
 */
export function parseNoRequiredCheckMessage(
  message: string,
): { repository: string; prCount: number | null } | null {
  const repository = REPOSITORY_PATTERN.exec(message)?.[1];
  if (repository === undefined) return null;
  const count = AFFECTED_COUNT_PATTERN.exec(message)?.[1];
  const prCount = count === undefined ? null : Number(count);
  return {
    repository: repository.toLowerCase(),
    prCount: prCount !== null && Number.isSafeInteger(prCount) ? prCount : null,
  };
}
