// PRの基点(PRのbaseブランチの先端と、先端とPRのheadのmerge-base)を求める部品。
// CI回が、PRが足した行と、基点から持っていた行を見分ける基準になる。
// 求められなければnullを返し、呼び出し側は基点の行を消したものとして拒否に倒す。

import {
  type GhClient,
  getBranchSha,
  getDefaultBranch,
  getPr,
} from "./github.ts";
import { fetchCommit } from "./metadata_git_ports.ts";
import { assertSha } from "./types.ts";
import {
  buildGitArgv,
  type CommandRunner,
  DEFAULT_TIMEOUT_MS,
  localGitEnv,
} from "./workspace.ts";

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * PRの基点。
 * `mergeBase`はbaseの先端とPRのheadのmerge-baseで、PRが足した行の基準になる。
 * `tip`はbaseの先端で、baseにすでにある行をPRの追加と見誤らないための基準になる。
 */
export type PrBase = {
  readonly mergeBase: string;
  readonly tip: string;
};

/** 基点を求めるためのI/O。テストでは偽物に差し替える。 */
export type PrMergeBaseIo = {
  /** PRが向いているbaseブランチの名前。 */
  readonly readBaseRef: () => Promise<string>;
  readonly readDefaultBranch: () => Promise<string>;
  /** ブランチの今の先端のsha。 */
  readonly readBranchSha: (branch: string) => Promise<string>;
  /** commit`sha`をローカルのcloneに取り込む。追跡refは動かさない。 */
  readonly fetchCommit: (sha: string) => Promise<void>;
  /** baseの先端`tipSha`とPRのheadのmerge-base。 */
  readonly mergeBase: (tipSha: string) => Promise<string>;
};

/**
 * PRの基点(merge-baseとbaseの先端)を返す。
 * baseブランチの今の先端を読み、そのcommitを取り込んでから、headとのmerge-baseを求める。
 * 先端を取り込むのは、merge-baseの計算がそのオブジェクトをローカルに要るためである。
 * どの段階の失敗も例外にせず、`null`を返す。基点が分からなければ、CI回は基点の行を消したものとして
 * テストの変更を拒否するので、`null`は以前と同じ結果になる。原因は`onError`に渡す。
 */
export async function resolvePrMergeBase(
  io: PrMergeBaseIo,
  onError?: (message: string) => void,
): Promise<PrBase | null> {
  try {
    const tip = await io.readBranchSha(await io.readBaseRef());
    if (!FULL_SHA.test(tip)) throw new Error("the base tip is not a full sha");
    await io.fetchCommit(tip);
    const base = await io.mergeBase(tip);
    if (!FULL_SHA.test(base)) {
      throw new Error("the merge base is not a full sha");
    }
    return { mergeBase: base, tip };
  } catch (err) {
    onError?.(err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * worktreeで`git merge-base -- <tipSha> <headSha>`を実行し、merge-baseのshaを返す。
 * 失敗したときと、出力がshaでないときは例外を投げる。
 * 例外の文にgitのstderrを入れない。
 */
export async function gitMergeBase(opts: {
  readonly run: CommandRunner;
  readonly cwd: string;
  readonly tipSha: string;
  readonly headSha: string;
}): Promise<string> {
  assertSha(opts.tipSha);
  assertSha(opts.headSha);
  const result = await opts.run(
    buildGitArgv(["merge-base", "--", opts.tipSha, opts.headSha]),
    { cwd: opts.cwd, env: localGitEnv(), timeoutMs: DEFAULT_TIMEOUT_MS },
  );
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error("git merge-base failed");
  }
  const sha = result.stdout.trim();
  assertSha(sha);
  return sha;
}

/** `resolvePrMergeBase`のI/Oを、GitHubのAPIとworktreeのgitで組む。 */
export function githubPrMergeBaseIo(input: {
  readonly client: GhClient;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly worktreeDir: string;
  readonly ghToken: string;
  readonly run: CommandRunner;
}): PrMergeBaseIo {
  const { client, owner, repo, worktreeDir } = input;
  return {
    readBaseRef: async () =>
      (await getPr(client, owner, repo, input.prNumber)).baseRef,
    readDefaultBranch: () => getDefaultBranch(client, owner, repo),
    readBranchSha: (branch) => getBranchSha(client, owner, repo, branch),
    fetchCommit: (sha) =>
      fetchCommit({
        cwd: worktreeDir,
        sha,
        ghToken: input.ghToken,
        run: input.run,
      }),
    mergeBase: (tipSha) =>
      gitMergeBase({
        run: input.run,
        cwd: worktreeDir,
        tipSha,
        headSha: input.headSha,
      }),
  };
}
