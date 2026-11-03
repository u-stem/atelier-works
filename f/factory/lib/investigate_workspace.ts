// 調査のClaudeが読むworktreeの置き場と、その作成・掃除。
// 保護パスに置く。置き場の検査やsymlink・submoduleの断りを緩めると、調査のClaudeがworkerの秘密に届くため。

import { lstat, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { maskSecrets } from "./log.ts";
import {
  assertOutputComplete,
  buildGitArgv,
  type CommandResult,
  type CommandRunner,
  type LockFs,
  localGitEnv,
  repoLockPath,
  withRepoLock,
} from "./workspace.ts";

/**
 * 調査のworktreeを置く親。worker imageがrootの所有・0700で作る。
 * `/run`、`/var/lib/factory`、`/tmp`、`/var/tmp`、`/workspaces`の外に置く。
 * 読み出しを塞ぐ一覧の`/var/lib/factory`は区切りまで一致を見るので、`/var/lib/factory-investigate`は塞がれない。
 */
export const INVESTIGATE_ROOT = "/var/lib/factory-investigate";

/** 隔離の測定が使う作業項目IDの代わり。実在の作業項目のIDと重ならない大きな固定値。 */
export const PROBE_RESERVED_ID = 2 ** 52;

/** 置き場の所有者。rootだけが置き場を作り、差し替えられる。 */
const ROOT_UID = 0;
/** 置き場のモード。所有者以外の権限と、setuid・setgid・stickyのビットを許さない。 */
const ROOT_MODE = 0o700;
const MODE_BITS = 0o7777;
/** `git ls-tree`のモード。symlinkとsubmodule(gitlink)。 */
const SYMLINK_MODE = "120000";
const GITLINK_MODE = "160000";
const FULL_SHA = /^[0-9a-f]{40}$/;
/** `git ls-tree -r -z`の1件の先頭。モード、種類、オブジェクト名、タブ。パスはこの後に続く。 */
const LS_TREE_ENTRY = /^(\d{6}) (?:blob|tree|commit) [0-9a-f]{40,64}\t/;

export type InvestigateStat = {
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly uid: number;
  readonly mode: number;
};

/** このモジュールが使うファイル操作。テストでは差し替える。 */
export type InvestigateFs = {
  /** symlinkをたどらずに調べる。無ければ`null`。 */
  readonly lstat: (path: string) => Promise<InvestigateStat | null>;
  readonly readdir: (path: string) => Promise<string[]>;
  /** 中身ごと消す。symlinkはたどらず、リンク自体を消す。無くても失敗しない。 */
  readonly rm: (path: string) => Promise<void>;
};

export const realInvestigateFs: InvestigateFs = {
  lstat: async (path) => {
    try {
      const stat = await lstat(path);
      return {
        isDirectory: stat.isDirectory(),
        isSymbolicLink: stat.isSymbolicLink(),
        uid: stat.uid,
        mode: stat.mode & 0o7777,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }
  },
  readdir: (path) => readdir(path),
  rm: (path) => rm(path, { recursive: true, force: true }),
};

export class InvestigateWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvestigateWorkspaceError";
  }
}

function assertWorkItemId(workItemId: number): void {
  if (!Number.isSafeInteger(workItemId) || workItemId <= 0) {
    throw new InvestigateWorkspaceError(
      `work item id must be a positive safe integer: ${String(workItemId)}`,
    );
  }
}

/**
 * 作業項目のworktreeのパスを返す。パスを求める関数はこの1つで、作成・後始末・掃除が共有する。
 * 作業項目のIDは正の安全な整数だけを受ける。パスの区切りや`..`を含む綴りを作らせないため。
 */
export function investigateWorktreeDir(
  workItemId: number,
  root: string = INVESTIGATE_ROOT,
): string {
  assertWorkItemId(workItemId);
  return join(root, String(workItemId));
}

/**
 * 置き場が、rootの所有で、モードが0700の、symlinkでないディレクトリであることを確かめる。満たさなければ例外を投げる。
 * 使うたびに呼ぶ。他のユーザーが差し替えた置き場に、worktreeを作ったり、掃除でたどったりしないため。
 * 置き場はworker imageが作る。無いときは実行時に作らず、imageの再ビルドを促す。
 */
export async function ensureInvestigateRoot(
  options: { readonly fs?: InvestigateFs; readonly root?: string } = {},
): Promise<void> {
  const fs = options.fs ?? realInvestigateFs;
  const root = options.root ?? INVESTIGATE_ROOT;
  const stat = await fs.lstat(root);
  if (stat === null) {
    throw new InvestigateWorkspaceError(
      `${root} does not exist: the worker image creates it, so rebuild and restart the worker with mise run up`,
    );
  }
  if (
    !stat.isDirectory ||
    stat.isSymbolicLink ||
    stat.uid !== ROOT_UID ||
    (stat.mode & MODE_BITS) !== ROOT_MODE
  ) {
    throw new InvestigateWorkspaceError(
      `${root} must be a directory owned by root with mode 0700 and must not be a symlink: rebuild and restart the worker with mise run up`,
    );
  }
}

export type InvestigateWorkspaceOptions = {
  readonly run: CommandRunner;
  /** worktreeの登録先の主リポジトリ。`<owner-repo-dir>/main`の形で、リポジトリのロックもここから決まる。 */
  readonly mainRepoDir: string;
  /** 既定は`INVESTIGATE_ROOT`。テストで差し替える。 */
  readonly root?: string;
  readonly fs?: InvestigateFs;
  readonly home?: string;
  readonly path?: string;
  readonly lockFs?: LockFs;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
};

export type CreateInvestigateWorktreeOptions = InvestigateWorkspaceOptions & {
  readonly workItemId: number;
  /** 解決済みの40桁のコミットのsha。ブランチ名や短いshaは受けない。 */
  readonly sha: string;
  /** shaをfetchするために使う。fetchのコマンドだけに渡す。 */
  readonly ghToken: string;
};

function lockOptions(opts: InvestigateWorkspaceOptions) {
  return {
    lockPath: repoLockPath(opts.mainRepoDir),
    ...(opts.lockFs !== undefined ? { lockFs: opts.lockFs } : {}),
    ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  };
}

function gitFailure(context: string, result: CommandResult): Error {
  return new InvestigateWorkspaceError(
    maskSecrets(`${context}: ${result.stderr.trim()}`),
  );
}

/** 主リポジトリでgitを実行する。ネットワークを使わないので、`GH_TOKEN`は渡さない。失敗したら例外を投げる。 */
async function runLocalGit(
  opts: InvestigateWorkspaceOptions,
  args: readonly string[],
  context: string,
): Promise<CommandResult> {
  const result = await opts.run(buildGitArgv(args), {
    cwd: opts.mainRepoDir,
    env: localGitEnv(opts.home, opts.path),
  });
  if (result.exitCode !== 0) throw gitFailure(`${context} failed`, result);
  return result;
}

/**
 * `ls-tree`の出力に、symlink(120000)かsubmodule(160000)があれば例外を投げる。
 * 読めない行があるときも例外を投げる。検査できないものを通さないためである。
 * `-z`の出力はパスを引用符で包まず、モードは行の先頭にあるので、パスの綴りでモードを偽れない。
 */
function assertNoLinkEntries(stdout: string): void {
  for (const entry of stdout.split("\0")) {
    if (entry === "") continue;
    const mode = LS_TREE_ENTRY.exec(entry)?.[1];
    if (mode === undefined) {
      throw new InvestigateWorkspaceError(
        "git ls-tree printed an entry that could not be parsed",
      );
    }
    if (mode === SYMLINK_MODE || mode === GITLINK_MODE) {
      const path = entry.slice(entry.indexOf("\t") + 1);
      throw new InvestigateWorkspaceError(
        `the tree has a symlink or submodule entry (mode ${mode}): ${JSON.stringify(path.slice(0, 200))}`,
      );
    }
  }
}

/**
 * `dir`の下で最初に見つかったsymlinkのパスを返す。無ければ`null`。worktreeの`.git`ファイルは見ない。
 * 読めない項目があれば例外を投げる。名前がUTF-8でない項目はlstatが`null`を返すので、通さずに断る。
 * 検査できないものを通すと、その下の木まで検査されないためである。
 */
async function findSymlink(
  fs: InvestigateFs,
  dir: string,
): Promise<string | null> {
  const pending = [dir];
  for (
    let current = pending.pop();
    current !== undefined;
    current = pending.pop()
  ) {
    for (const name of await fs.readdir(current)) {
      if (current === dir && name === ".git") continue;
      const path = join(current, name);
      const stat = await fs.lstat(path);
      if (stat === null) {
        throw new InvestigateWorkspaceError(
          `an entry in the checked-out files could not be inspected: ${JSON.stringify(path.slice(0, 300))}`,
        );
      }
      if (stat.isSymbolicLink) return path;
      if (stat.isDirectory) pending.push(path);
    }
  }
  return null;
}

/** 作ったworktreeを消し、登録も消す。失敗しても握りつぶす。呼び出し側は、元の失敗を投げる。 */
async function discardWorktree(
  opts: InvestigateWorkspaceOptions,
  fs: InvestigateFs,
  dir: string,
): Promise<void> {
  try {
    await fs.rm(dir);
    await runLocalGit(opts, ["worktree", "prune"], "git worktree prune");
  } catch {
    // 消せなかった残りは、次の掃除(`purgeInvestigateRoot`)が消す。
  }
}

/**
 * 解決済みの`sha`のdetachedなworktreeを、作業項目の置き場に作り、パスを返す。
 * リポジトリのロックを1度だけ取り、その中で次の順に実行する。
 * 入れ子のロックを避けるため、`addDetachedWorktree`は呼ばない。
 * 1. `sha`をfetchする。clone済みのリポジトリが持たない`sha`でも取れる。
 * 2. `git worktree prune`で、ディスクから消えたworktreeの登録を消す。同じIDで作り直せるようにする。
 * 3. `git ls-tree -r`で、symlink(120000)かsubmodule(160000)が1つでもあれば例外を投げる。
 *    対象リポジトリの中身は信頼できない入力で、symlinkはworkerの秘密を指しうる。
 * 4. `git worktree add --detach`で、`core.symlinks=false`のままcheckoutする。
 * 5. checkoutしたファイルにsymlinkが無いことを、ファイルシステムで確かめ直す。
 *    あるときと、読めない項目があって確かめ終えられないときは、worktreeを消して例外を投げる。
 * `sha`とIDの形、置き場の検査(`ensureInvestigateRoot`)を満たさなければ、何も実行せずに例外を投げる。
 */
export async function createInvestigateWorktree(
  opts: CreateInvestigateWorktreeOptions,
): Promise<{ readonly dir: string }> {
  if (!FULL_SHA.test(opts.sha)) {
    throw new InvestigateWorkspaceError(
      `sha must be 40 lowercase hex digits: ${JSON.stringify(opts.sha.slice(0, 80))}`,
    );
  }
  const root = opts.root ?? INVESTIGATE_ROOT;
  const fs = opts.fs ?? realInvestigateFs;
  const dir = investigateWorktreeDir(opts.workItemId, root);
  await ensureInvestigateRoot({ fs, root });

  return withRepoLock({
    ...lockOptions(opts),
    fn: async () => {
      const fetchResult = await opts.run(
        buildGitArgv(["fetch", "origin", "--", opts.sha], { network: true }),
        {
          cwd: opts.mainRepoDir,
          env: {
            ...localGitEnv(opts.home, opts.path),
            GH_TOKEN: opts.ghToken,
          },
        },
      );
      if (fetchResult.exitCode !== 0) {
        throw gitFailure(`git fetch ${opts.sha} failed`, fetchResult);
      }

      await runLocalGit(opts, ["worktree", "prune"], "git worktree prune");

      // shaは40桁のhexなので、`-`で始まらない。`--`は付けない。
      const tree = await runLocalGit(
        opts,
        ["ls-tree", "-r", "-z", opts.sha],
        "git ls-tree",
      );
      assertOutputComplete("git ls-tree", tree);
      assertNoLinkEntries(tree.stdout);

      await runLocalGit(
        opts,
        ["worktree", "add", "--detach", "--", dir, opts.sha],
        "git worktree add --detach",
      );

      let link: string | null;
      try {
        link = await findSymlink(fs, dir);
      } catch (error) {
        await discardWorktree(opts, fs, dir);
        throw error;
      }
      if (link !== null) {
        await discardWorktree(opts, fs, dir);
        throw new InvestigateWorkspaceError(
          `a symlink appeared in the checked-out files: ${JSON.stringify(link.slice(0, 300))}`,
        );
      }
      return { dir };
    },
  });
}

export type PurgeInvestigateRootOptions = InvestigateWorkspaceOptions & {
  /** 消さない作業項目のID。無ければすべて消す。 */
  readonly keepId?: number;
};

/**
 * 置き場の下の項目を、`keepId`の作業項目のディレクトリを除いてすべて消し、消したパスを返す。
 * 前の調査の残りが、次の調査のClaudeに読めないようにするためである。
 * symlinkはたどらずリンク自体を消す。`.git`を持たない項目やファイルも消す。
 * `keepId`の項目も、ディレクトリでなければ(symlinkを含む)消す。worktreeとして使わせないためである。
 * 消した後に、`mainRepoDir`で`git worktree prune`を実行する。主リポジトリは、残った項目の`.git`ファイルからは求めない。
 * 1件が消せなくても残りを続け、pruneの後に、消せなかった項目を挙げて例外を投げる。
 * 置き場の検査を満たさなければ、何も消さずに例外を投げる。
 * リポジトリのロックの下で実行するので、同じリポジトリの`createInvestigateWorktree`とは重ならない。
 * 置き場は全リポジトリで共有し、ロックは`mainRepoDir`の1つだけなので、他のリポジトリの項目はロックなしで消す。
 */
export async function purgeInvestigateRoot(
  opts: PurgeInvestigateRootOptions,
): Promise<{ readonly removed: readonly string[] }> {
  const root = opts.root ?? INVESTIGATE_ROOT;
  const fs = opts.fs ?? realInvestigateFs;
  if (opts.keepId !== undefined) assertWorkItemId(opts.keepId);
  const keepName = opts.keepId === undefined ? null : String(opts.keepId);
  await ensureInvestigateRoot({ fs, root });

  return withRepoLock({
    ...lockOptions(opts),
    fn: async () => {
      const removed: string[] = [];
      const failed: string[] = [];
      for (const name of await fs.readdir(root)) {
        const path = join(root, name);
        if (name === keepName) {
          const stat = await fs.lstat(path);
          if (stat?.isDirectory && !stat.isSymbolicLink) continue;
        }
        try {
          await fs.rm(path);
          removed.push(path);
        } catch {
          failed.push(path);
        }
      }
      await runLocalGit(opts, ["worktree", "prune"], "git worktree prune");
      if (failed.length > 0) {
        throw new InvestigateWorkspaceError(
          `could not remove ${failed.map((path) => JSON.stringify(path)).join(", ")}`,
        );
      }
      return { removed };
    },
  });
}

/**
 * `disableInvestigateInstructions`が`.disabled`を付けて無効にする名前。
 * Claude Codeが、指示(`CLAUDE.md`とその`@`の取り込み)、設定、MCPの定義として作業ディレクトリから読む。
 * 照合は、大文字小文字を区別しない。
 */
export const INSTRUCTION_ENTRY_NAMES: readonly string[] = [
  "CLAUDE.md",
  "CLAUDE.local.md",
  ".claude",
  ".mcp.json",
  ".claude.json",
];

const INSTRUCTION_NAME_KEYS: ReadonlySet<string> = new Set(
  INSTRUCTION_ENTRY_NAMES.map((name) => name.toLowerCase()),
);
const DISABLED_SUFFIX = ".disabled";

/** 無効化に使うファイル操作。検査と一覧と削除は`InvestigateFs`と同じで、改名を足す。 */
export type DisableInstructionsFs = InvestigateFs & {
  /** 同じ親の中で改名する。シンボリックリンクはたどらず、リンク自体を改名する。 */
  readonly rename: (from: string, to: string) => Promise<void>;
};

export const realDisableInstructionsFs: DisableInstructionsFs = {
  ...realInvestigateFs,
  rename: (from, to) => rename(from, to),
};

export type DisableInvestigateInstructionsOptions = Omit<
  InvestigateWorkspaceOptions,
  "fs"
> & {
  readonly workItemId: number;
  readonly fs?: DisableInstructionsFs;
};

/**
 * `dir`の下で、指示や設定の名前に当たる項目の、`dir`からの相対パスを返す。
 * 結果は、深い方から先に並べる。
 * 当たった項目の中にも入る。`.claude`の中の`CLAUDE.md`や、`CLAUDE.md`という名前のディレクトリの中の`CLAUDE.md`も、
 * Claude Codeが読みうるためである。名前が`.disabled`で終わるディレクトリの中も飛ばさない。
 * 作業ディレクトリ直下の`.git`ファイルだけを見ない。シンボリックリンクはたどらない。
 * 読めない項目があれば例外を投げる。検査できないものを通すと、その下の木まで検査されないためである。
 */
async function findInstructionEntries(
  fs: DisableInstructionsFs,
  dir: string,
): Promise<string[]> {
  const found: string[] = [];
  const pending: { readonly path: string; readonly relative: string }[] = [
    { path: dir, relative: "" },
  ];
  for (
    let current = pending.pop();
    current !== undefined;
    current = pending.pop()
  ) {
    for (const name of await fs.readdir(current.path)) {
      if (current.relative === "" && name === ".git") continue;
      const path = join(current.path, name);
      const relative =
        current.relative === "" ? name : `${current.relative}/${name}`;
      const stat = await fs.lstat(path);
      if (stat === null) {
        throw new InvestigateWorkspaceError(
          `an entry in the checked-out files could not be inspected: ${JSON.stringify(path.slice(0, 300))}`,
        );
      }
      if (INSTRUCTION_NAME_KEYS.has(name.toLowerCase())) found.push(relative);
      if (stat.isDirectory && !stat.isSymbolicLink) {
        pending.push({ path, relative });
      }
    }
  }
  const depth = (relative: string): number => relative.split("/").length;
  return found.sort((a, b) => depth(b) - depth(a));
}

/**
 * 作業項目のworktreeの中で、指示や設定の名前(`INSTRUCTION_ENTRY_NAMES`)の項目を、入れ子の下まで`.disabled`を付けた名前に改名する。
 * 対象リポジトリの`CLAUDE.md`は信頼できない入力で、`@`の取り込みで`/proc/self/environ`などを読ませられうるためである。
 * 改名は深い方から先に行うので、`.claude`の中の`CLAUDE.md`は、`.claude`より先に改名される。
 * 改名の後に、`.git`ファイル以外の全体をもう一度調べ、対象の名前が1つでも残っていれば失敗として扱う。
 * 内容は変えない。改名の前後でworktreeの他のファイルは変わらない。
 * `createInvestigateWorktree`の中には入れず、調査の入口が作成の後に別に呼ぶ。
 * 隔離の測定のworktreeを作る共有の関数に入れると、測定の前提が変わり、判定の版を上げる測り直しになるためである。
 * 改名先の名前が既にあるとき、改名に失敗したとき、改名の後にも対象が残るとき、検査できない項目があるときは、
 * リポジトリのロックの下でworktreeを消して、例外を投げる。例外の文に、失敗の原因のメッセージは載せない。
 * 作業項目のIDの形は、`investigateWorktreeDir`が確かめ、置き場の所有者とモードは、改名の前に`ensureInvestigateRoot`が確かめる。
 * 置き場を信頼できないときは、改名もworktreeの削除もせずに例外を投げる。
 */
export async function disableInvestigateInstructions(
  opts: DisableInvestigateInstructionsOptions,
): Promise<{ readonly dir: string; readonly renamed: readonly string[] }> {
  const fs = opts.fs ?? realDisableInstructionsFs;
  const dir = investigateWorktreeDir(opts.workItemId, opts.root);
  // 置き場を信頼できないときは、何も改名せず、worktreeも消さずに例外を投げる。
  // 差し替えられた置き場の先を、改名や削除でたどらないためである。
  await ensureInvestigateRoot({ fs, root: opts.root ?? INVESTIGATE_ROOT });
  try {
    const stat = await fs.lstat(dir);
    if (stat === null || !stat.isDirectory || stat.isSymbolicLink) {
      throw new InvestigateWorkspaceError(
        `the worktree is not a directory: ${JSON.stringify(dir.slice(0, 300))}`,
      );
    }
    const renamed: string[] = [];
    for (const relative of await findInstructionEntries(fs, dir)) {
      const from = join(dir, relative);
      const to = `${from}${DISABLED_SUFFIX}`;
      if ((await fs.lstat(to)) !== null) {
        throw new InvestigateWorkspaceError(
          `the name for the disabled entry is already taken: ${JSON.stringify(to.slice(0, 300))}`,
        );
      }
      try {
        await fs.rename(from, to);
      } catch {
        throw new InvestigateWorkspaceError(
          `could not rename an instruction entry: ${JSON.stringify(from.slice(0, 300))}`,
        );
      }
      renamed.push(relative);
    }
    const remaining = await findInstructionEntries(fs, dir);
    if (remaining.length > 0) {
      throw new InvestigateWorkspaceError(
        `an instruction entry remains after the rename: ${JSON.stringify((remaining[0] ?? "").slice(0, 300))}`,
      );
    }
    return { dir, renamed };
  } catch (error) {
    await discardUnderLock(opts, fs, dir);
    throw error instanceof InvestigateWorkspaceError
      ? error
      : new InvestigateWorkspaceError(
          "could not disable the instruction entries of the worktree",
        );
  }
}

/** リポジトリのロックの下で、worktreeを消して登録も消す。ロックを取れなくても握りつぶす。残りは次の掃除が消す。 */
async function discardUnderLock(
  opts: InvestigateWorkspaceOptions,
  fs: InvestigateFs,
  dir: string,
): Promise<void> {
  try {
    await withRepoLock({
      ...lockOptions(opts),
      fn: () => discardWorktree(opts, fs, dir),
    });
  } catch {
    // 消せなかった残りは、次の掃除(`purgeInvestigateRoot`)が消す。
  }
}
