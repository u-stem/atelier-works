// PRの基点(PRのbaseブランチの先端とPRのheadのmerge-base)のcommitを求める部品。
// CI回が、PRが基点から持っていたテスト行を消していないかを確かめる基準になる。

import type { CommandRunner } from "./workspace.ts";

/** 基点を求めるためのI/O。テストでは偽物に差し替える。 */
export type PrMergeBaseIo = {
  readonly readBaseRef: () => Promise<string>;
  readonly readBranchSha: (branch: string) => Promise<string>;
  readonly fetchCommit: (sha: string) => Promise<void>;
  readonly mergeBase: (tipSha: string) => Promise<string>;
};

export async function resolvePrMergeBase(
  _io: PrMergeBaseIo,
  _onError?: (message: string) => void,
): Promise<string | null> {
  return null;
}

export async function gitMergeBase(_opts: {
  readonly run: CommandRunner;
  readonly cwd: string;
  readonly tipSha: string;
  readonly headSha: string;
}): Promise<string> {
  return "";
}
