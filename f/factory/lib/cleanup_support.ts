// `cleanup_workspaces.ts`が使う判定と解析の関数をまとめる。
// 入出力(gitのworktree操作、`ps`とシグナル、`du`)はあちらのスクリプトが行う。

import type { FactoryConfig } from "./types.ts";
import type { WorktreeEntry } from "./workspace.ts";

// ---------------------------------------------------------------------------
// worktreeのパスの組み立て
// ---------------------------------------------------------------------------

/**
 * 対象リポジトリのfetch専用のメインのクローンのディレクトリを返す。
 * `ensureRepo`の`<baseDir>/<owner>/<repo>/main`と同じ式
 * (`baseDir`の既定値は`/workspaces`)。
 * `cleanup_workspaces.ts`に要るのは決まったパスだけで、
 * クローンやfetchの副作用は要らないので、`ensureRepo`は呼ばずに式を写している。
 */
export function mainRepoDir(owner: string, repo: string): string {
  return `/workspaces/${owner}/${repo}/main`;
}

/**
 * Issueの作業項目が要件定義の生成で使う、読み取り専用のdetachedなworktreeのパスを返す。
 * `f/factory/steps/pipeline_prepare.ts`の`buildRequirementsWorktreeDir`と同じ式。
 * importせずに写しているのは、トップレベルのスクリプトがsteps/からimportすると、
 * 「stepsはそれぞれのフローが組み込む」という境界が曖昧になるためである。
 * 小さく意図的な重複の前例は`poll_support.ts`の冒頭のコメントにある。
 */
export function requirementsWorktreeDir(
  owner: string,
  repo: string,
  issueNumber: number,
): string {
  return `/workspaces/${owner}/${repo}/req-${issueNumber}`;
}

// ---------------------------------------------------------------------------
// issueWorktreePaths: Issueの作業項目が残すworktree
// ---------------------------------------------------------------------------

/**
 * Issueの作業項目のworktreeを特定する`work_items`の2列。
 * 構造的な型にして、`WorkItem`(`lib/types.ts`)をそのまま渡せるようにしている。
 */
export type IssueWorktreeSource = {
  readonly issue_number: number | null;
  readonly branch: string | null;
};

/**
 * Issueの作業項目1件について、`cleanup_workspaces.ts`が削除すべきworktreeのパスを返す。
 * 対象は、一覧にあれば要件定義用のdetachedな`req-<N>`(`requirementsWorktreeDir`)と、
 * 作業項目にブランチがあれば`item.branch`(implementブランチ、`work_items.branch`)を
 * チェックアウトしたworktreeである。
 * `worktrees`は、そのリポジトリの`git worktree list --porcelain`を解析したもの。
 * fetch専用のメインのクローン(`mainRepoDir`)は、たまたまそのブランチにあっても返さない。
 */
export function issueWorktreePaths(
  owner: string,
  repo: string,
  item: IssueWorktreeSource,
  worktrees: readonly WorktreeEntry[],
): string[] {
  const main = mainRepoDir(owner, repo);
  const paths: string[] = [];
  if (item.issue_number !== null) {
    const reqDir = requirementsWorktreeDir(owner, repo, item.issue_number);
    if (worktrees.some((entry) => entry.path === reqDir)) {
      paths.push(reqDir);
    }
  }
  if (item.branch !== null) {
    for (const entry of worktrees) {
      if (
        entry.branch === item.branch &&
        entry.path !== main &&
        !paths.includes(entry.path)
      ) {
        paths.push(entry.path);
      }
    }
  }
  return paths;
}

// ---------------------------------------------------------------------------
// excludeActiveWorktrees: 稼働中の作業項目が使っているworktreeは削除しない。
// implementブランチはPRのheadブランチでもあり、`createGtrWorktree`はブランチごとに
// worktreeを1つ使い回すので、Issueの作業項目とpr_fixの作業項目が同じworktreeを共有する。
// 古いpr_openのIssueの作業項目が実行中のpr_fixのworktreeを奪ってはならず、
// 古いpr_fixの作業項目が再実装のworktreeを奪ってもならない。
// ---------------------------------------------------------------------------

/**
 * 稼働中の作業項目が使っているもの。
 * `issue_number`から決まる`req-<N>`のディレクトリと、`branch`上のworktreeである。
 * `branch`はIssueの作業項目ならimplementブランチ、pr_fixの作業項目なら
 * 呼び出し側が解決したPRのheadブランチ。
 */
export type WorktreeHolder = {
  readonly owner: string;
  readonly repo: string;
  readonly issue_number: number | null;
  readonly branch: string | null;
};

/** `targetDirs`から、`owner`/`repo`で稼働中の作業項目が使うパスを除いて返す。 */
export function excludeActiveWorktrees(
  targetDirs: readonly string[],
  holders: readonly WorktreeHolder[],
  worktrees: readonly WorktreeEntry[],
  owner: string,
  repo: string,
): string[] {
  const held = new Set<string>();
  for (const holder of holders) {
    if (holder.owner !== owner || holder.repo !== repo) continue;
    if (holder.issue_number !== null) {
      held.add(requirementsWorktreeDir(owner, repo, holder.issue_number));
    }
    if (holder.branch !== null) {
      for (const entry of worktrees) {
        if (entry.branch === holder.branch) held.add(entry.path);
      }
    }
  }
  return targetDirs.filter((dir) => !held.has(dir));
}

// ---------------------------------------------------------------------------
// groupByRepo: 古い作業項目の一覧を(owner, repo)ごとにまとめる
// ---------------------------------------------------------------------------

export type RepoGroup<T> = {
  readonly owner: string;
  readonly repo: string;
  readonly items: T[];
};

/**
 * `items`を`(owner, repo)`ごとにまとめる。
 * グループの順もグループ内の項目の順も、最初に現れた順を保つ。
 * `cleanup_workspaces.ts`が`listWorktrees`と`pruneWorktrees`を、
 * 古い作業項目ごとではなくリポジトリごとに1回だけ呼べるようにするためのもの。
 */
export function groupByRepo<
  T extends { readonly owner: string; readonly repo: string },
>(items: readonly T[]): RepoGroup<T>[] {
  const order: string[] = [];
  const groups = new Map<string, RepoGroup<T>>();
  for (const item of items) {
    const key = `${item.owner}/${item.repo}`;
    const existing = groups.get(key);
    if (existing !== undefined) {
      existing.items.push(item);
      continue;
    }
    groups.set(key, { owner: item.owner, repo: item.repo, items: [item] });
    order.push(key);
  }
  return order.map((key) => {
    const group = groups.get(key);
    if (group === undefined) {
      throw new Error(`groupByRepo: missing group for key ${key}`);
    }
    return group;
  });
}

/**
 * 古い作業項目のグループを、今日掃除するリポジトリと見送るリポジトリに分ける。
 * 稼働中のpr_fixのheadブランチを解決できなかったリポジトリは、
 * 使用中のworktreeが分からないので見送り、それ以外を掃除する。
 */
export function partitionRepoGroups<T>(
  groups: readonly RepoGroup<T>[],
  unresolved: readonly { readonly owner: string; readonly repo: string }[],
): { readonly sweep: RepoGroup<T>[]; readonly skipped: RepoGroup<T>[] } {
  const isUnresolved = (group: RepoGroup<T>): boolean =>
    unresolved.some(
      (entry) => entry.owner === group.owner && entry.repo === group.repo,
    );
  return {
    sweep: groups.filter((group) => !isUnresolved(group)),
    skipped: groups.filter(isUnresolved),
  };
}

/** `partitionRepoGroups`で見送ったリポジトリについてのnoticeの文言を返す。 */
export function unresolvedHoldersNoticeMessage(
  owner: string,
  repo: string,
): string {
  return `${owner}/${repo}で稼働中の自動修正のブランチを確認できなかったため、このリポジトリの作業領域の掃除を見送りました。`;
}

// ---------------------------------------------------------------------------
// selectOrphanClaudePids: `ps -eo pid,etimes,args`を解析する
// ---------------------------------------------------------------------------

type PsEntry = {
  readonly pid: number;
  readonly etimes: number;
  readonly args: string;
};

/**
 * `ps -eo pid,etimes,args`のデータ行1行(`<pid> <etimes> <args...>`)を解析する。
 * 区切りは空白で、`args`は自由な形式。
 * 先頭が2つの数値でない行には`null`を返す。
 * ヘッダー行(`PID ELAPSED COMMAND`など)は、特別扱いせずにこの規則で捨てる。
 */
function parsePsLine(line: string): PsEntry | null {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
  if (match === null) return null;
  const pidText = match[1];
  const etimesText = match[2];
  const args = match[3];
  if (pidText === undefined || etimesText === undefined || args === undefined) {
    return null;
  }
  const pid = Number(pidText);
  const etimes = Number(etimesText);
  if (!Number.isFinite(pid) || !Number.isFinite(etimes)) return null;
  return { pid, etimes, args };
}

/**
 * `args`(`ps`が出すプロセス1つのコマンドライン全体)が、
 * ヘッドレスなClaudeの起動(`claude ... -p ...`)に見えるかを返す。
 * バイナリのパスの接頭辞(`/usr/local/bin/claude`)やオプションの順は問わない。
 */
function isClaudeHeadlessInvocation(args: string): boolean {
  const tokens = args.split(/\s+/).filter((token) => token.length > 0);
  const command = tokens[0];
  if (command === undefined) return false;
  const looksLikeClaude = command === "claude" || command.endsWith("/claude");
  return looksLikeClaude && tokens.slice(1).includes("-p");
}

/**
 * `ps -eo pid,etimes,args`の出力を解析し、経過時間(`etimes`、秒)が
 * `thresholdSec`を超えたヘッドレスなClaude(`claude -p`)のプロセスのpidを返す。
 * `thresholdSec`は`orphanClaudeThresholdSec`が返す値を渡す。
 *
 * `lib/claude.ts`の`runClaude`は、自分が直接起動したプロセスにタイムアウトを課す。
 * どの実行のタイムアウトも過ぎてまだ動いているなら、その仕組みが働く機会が無かった
 * ことになる。たとえば、親のWindmillジョブが先に停止・キャンセルされ、
 * シグナルを送る前に子プロセスの親が付け替わった場合である。
 * そのため、ここで見つかるプロセスは孤児であり、終了させてよい。
 */
export function selectOrphanClaudePids(
  psOutput: string,
  thresholdSec: number,
): number[] {
  return psOutput
    .split("\n")
    .map(parsePsLine)
    .filter((entry): entry is PsEntry => entry !== null)
    .filter(
      (entry) =>
        entry.etimes > thresholdSec && isClaudeHeadlessInvocation(entry.args),
    )
    .map((entry) => entry.pid);
}

const ORPHAN_GRACE_SEC = 300;

/**
 * ヘッドレスなClaudeのプロセスを孤児とみなすまでの秒数を返す。
 * 実行ごとの2つのタイムアウトのうち長いほう(implementフローの
 * `implement_timeout_sec`が最長で、既定値は3600秒)に猶予を足す。
 * 動いているimplementの実行を終了させないためである。
 */
export function orphanClaudeThresholdSec(
  config: Pick<FactoryConfig, "claude_timeout_sec" | "implement_timeout_sec">,
): number {
  return (
    Math.max(config.claude_timeout_sec, config.implement_timeout_sec) +
    ORPHAN_GRACE_SEC
  );
}

// ---------------------------------------------------------------------------
// terminateOrphans: SIGTERMを送り、待ってからSIGKILLを送る(依存は注入できる)
// ---------------------------------------------------------------------------

export type TerminateOrphansDeps = {
  /**
   * `pid`に`signal`を送る。既定は`process.kill`。
   * 終了済みのpidへの対策は要らない。`terminateOrphans`がすべての呼び出しを
   * try/catchで包むためで、`ps`の取得からこの呼び出しまでの間に
   * プロセスが終了していても誤りとはしない。
   */
  readonly kill?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  /** `pid`がまだ生きているかを返す。既定は`process.kill(pid, 0)`による存在確認。 */
  readonly isAlive?: (pid: number) => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_KILL_GRACE_MS = 10_000;

function defaultKill(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  process.kill(pid, signal);
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function safeKill(
  kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => void,
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
): void {
  try {
    kill(pid, signal);
  } catch {
    // `ps`の取得からこの呼び出しまでの間に終了していた。誤りとはしない。
  }
}

export type TerminateOrphansResult = {
  /** SIGTERMを送ったすべてのpid。 */
  readonly terminated: number[];
  /** そのうち猶予の後も生きていて、SIGKILLを送ったpid。 */
  readonly killed: number[];
};

/**
 * `pids`のすべてにSIGTERMを送り、`graceMs`(既定は10秒)待ってから、
 * まだ生きているものにSIGKILLを送る。
 * 実際に10秒待ったりOSのシグナルを送ったりせずにテストできるよう、
 * `deps`はすべて省略でき、差し替えられる。
 */
export async function terminateOrphans(
  pids: readonly number[],
  deps: TerminateOrphansDeps = {},
  graceMs: number = DEFAULT_KILL_GRACE_MS,
): Promise<TerminateOrphansResult> {
  const kill = deps.kill ?? defaultKill;
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const sleep = deps.sleep ?? defaultSleep;

  for (const pid of pids) {
    safeKill(kill, pid, "SIGTERM");
  }
  await sleep(graceMs);
  const stillAlive = pids.filter((pid) => isAlive(pid));
  for (const pid of stillAlive) {
    safeKill(kill, pid, "SIGKILL");
  }
  return { terminated: [...pids], killed: stillAlive };
}

// ---------------------------------------------------------------------------
// ディスク使用量(`du -sk /workspaces`)
// ---------------------------------------------------------------------------

/**
 * `du -sk`の出力(`<size>\t<path>`)から、先頭のブロック数(`-k`によりKiB単位)を取り出す。
 * 想定外の出力なら例外を投げる。
 */
export function parseDiskUsageKb(duOutput: string): number {
  const match = duOutput.trim().match(/^(\d+)/);
  const sizeText = match?.[1];
  if (sizeText === undefined) {
    throw new Error(
      `cleanup_workspaces: unexpected 'du -sk' output: ${JSON.stringify(duOutput)}`,
    );
  }
  return Number(sizeText);
}

/** `factory.notices`に載せるディスク使用量の日本語の文言を、読みやすいMiB単位で返す。 */
export function formatDiskUsageMessage(usageKb: number, path: string): string {
  const usageMib = (usageKb / 1024).toFixed(1);
  return `${path} のディスク使用量は約 ${usageMib} MiB です。`;
}
