// `self_update`が反映に含まれるPRを記録するための、純粋な解析。
// 入力はself cloneのコミットログで、マージのコミットの文は信頼できない入力として扱う。
// I/Oは持たない。gitの起動は`self_update.ts`が行う。

import {
  assertPullRequestUrl,
  type DeploymentPullRequest,
  type PullRequestOrigin,
  sanitizePullRequestTitle,
} from "./types.ts";
import { omittedMarkerIndex } from "./workspace.ts";

/**
 * `git log -z --first-parent`に渡す`--format`。
 * 親のsha、件名、本文を0x1fで区切り、コミットの終わりはNULになる。
 * NULはコミットメッセージに入らないので、メッセージの中身がコミットの境界を偽れない。
 */
export const MERGED_PULL_REQUESTS_LOG_FORMAT = "%P%x1f%s%x1f%b";

/** 1回の反映に記録するPRの上限。長く止まった後の反映で、記録が膨らまないようにする。 */
export const MAX_PULL_REQUESTS_PER_DEPLOYMENT = 100;

const MERGE_SUBJECT = /^Merge pull request #([1-9][0-9]{0,8}) from (\S+)$/;
const SQUASH_SUBJECT = /^(.*\S)\s+\(#([1-9][0-9]{0,8})\)$/;
const FACTORY_BRANCH = /^factory\/issue-[0-9]+-wi-[0-9]+$/;
const GITHUB_REPO_URL =
  /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9_-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/*$/;

type RepoRef = { readonly owner: string; readonly repo: string };

function parseRepoUrl(url: string): RepoRef | null {
  const match = GITHUB_REPO_URL.exec(url.trim());
  if (match === null) return null;
  const owner = match[1];
  const repo = match[2];
  if (owner === undefined || repo === undefined) return null;
  if (repo === "." || repo === "..") return null;
  return { owner, repo };
}

function buildPullRequestUrl(
  repoRef: RepoRef | null,
  number: number,
): string | null {
  if (repoRef === null) return null;
  const url = `https://github.com/${repoRef.owner}/${repoRef.repo}/pull/${String(number)}`;
  try {
    assertPullRequestUrl(url);
  } catch {
    return null;
  }
  return url;
}

function firstBodyLine(body: string): string {
  return body.split("\n").find((line) => line.trim().length > 0) ?? "";
}

/**
 * マージのコミットの頭の名前`<owner>/<branch>`から、PRの作り手を決める。
 * Factoryの実装ブランチ(`factory/issue-<N>-wi-<id>`)で、ownerがFactoryのリポジトリと
 * 同じときだけ`factory`にする。forkから同じ名前のブランチを出しても`factory`にならない。
 * 実装ブランチでなければ、Factoryが作ったPRではないので`human`にする。
 */
function classifyHead(
  head: string,
  repoRef: RepoRef | null,
): PullRequestOrigin {
  // Factoryのリポジトリが分からなければ、ownerを比べられない。確かな情報が無いので振り分けない。
  if (repoRef === null) return "unknown";
  const slash = head.indexOf("/");
  if (slash <= 0) return "unknown";
  const owner = head.slice(0, slash);
  const branch = head.slice(slash + 1);
  const sameOwner = owner.toLowerCase() === repoRef.owner.toLowerCase();
  return sameOwner && FACTORY_BRANCH.test(branch) ? "factory" : "human";
}

function parseEntry(
  entry: string,
  repoRef: RepoRef | null,
): DeploymentPullRequest | null {
  const fields = entry.split("\x1f");
  const parents = fields[0]?.trim().split(/\s+/).filter(Boolean) ?? [];
  const subject = fields[1] ?? "";
  const body = fields.slice(2).join("\x1f");

  const merge = MERGE_SUBJECT.exec(subject);
  if (merge !== null && parents.length >= 2) {
    const number = Number(merge[1]);
    return {
      number,
      title: sanitizePullRequestTitle(firstBodyLine(body)),
      origin: classifyHead(merge[2] ?? "", repoRef),
      url: buildPullRequestUrl(repoRef, number),
    };
  }

  const squash = SQUASH_SUBJECT.exec(subject);
  if (squash !== null && parents.length === 1) {
    const number = Number(squash[2]);
    return {
      number,
      title: sanitizePullRequestTitle(squash[1] ?? ""),
      origin: "unknown",
      url: buildPullRequestUrl(repoRef, number),
    };
  }
  return null;
}

/**
 * 出力を、完全な要素に分ける。
 * 出力が上限を超えると、`readStreamCapped`が先頭と末尾の間を捨てて印を入れる。
 * 印をまたぐ要素は壊れているので、印を含む要素とそれ以降は使わない。
 * ログは新しい順なので、先頭側の要素は保たれ、失うのは間の要素である。
 */
function completeEntries(output: string): string[] {
  const marker = omittedMarkerIndex(output);
  const kept = marker < 0 ? output : output.slice(0, marker);
  // 各要素はNULで終わる。印の手前で途切れた最後の要素にはNULが無いので、捨てる。
  const end = marker < 0 ? kept.length : kept.lastIndexOf("\0") + 1;
  return kept
    .slice(0, end)
    .split("\0")
    .filter((entry) => entry.length > 0);
}

/**
 * `git log -z --first-parent --format=MERGED_PULL_REQUESTS_LOG_FORMAT`の出力から、
 * 反映に含まれるPRを新しい順に返す。同じ番号は最初の1件だけを残し、
 * `MAX_PULL_REQUESTS_PER_DEPLOYMENT`件で打ち切る。
 *
 * mainの第1親をたどるコミットだけを読む。PRのブランチの中のコミットが、
 * 件名でマージのコミットを装えないようにするためである。
 * 件名`Merge pull request #N from <owner>/<branch>`は、親が2つ以上のコミットだけを読む。
 * 件名の末尾が`(#N)`のコミットは、親が1つのときだけ読み、ブランチが分からないので作り手は`unknown`にする。
 * mainに直接pushされたコミットも、この形なら記録される。PRの実在は確かめない。
 * `factoryRepoUrl`はPRのURLを組み立てるのに使う。GitHubのHTTPSのURLでなければ、URLは`null`になる。
 */
export function parseMergedPullRequests(
  output: string,
  factoryRepoUrl: string,
): DeploymentPullRequest[] {
  const repoRef = parseRepoUrl(factoryRepoUrl);
  const seen = new Set<number>();
  const result: DeploymentPullRequest[] = [];
  for (const entry of completeEntries(output)) {
    if (entry.length === 0) continue;
    const parsed = parseEntry(entry, repoRef);
    if (parsed === null || seen.has(parsed.number)) continue;
    seen.add(parsed.number);
    result.push(parsed);
    if (result.length >= MAX_PULL_REQUESTS_PER_DEPLOYMENT) break;
  }
  return result;
}
