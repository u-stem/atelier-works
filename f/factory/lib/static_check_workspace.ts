// 保護パスを変えたラウンドの静的検査のために、基準のcommitの木にPRの変更を重ねた一時の作業木を作る。
// 検査の道具と設定は基準の版を使い、PRの版は重ねない。検査が実行するファイルをPRが変えたときは、作業木を作らない。
// PRのファイルを読ませるだけにして、PRのコードを検査に実行させないためである。

import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { displayPath, isSafeRepoPath } from "./ci_fix_paths.ts";
import { jobTmpEnv } from "./job_tmp.ts";
import { errorMessage, type Logger, logger, maskSecrets } from "./log.ts";
import {
  type ChangedPath,
  FORBIDDEN_PATH_PREFIXES,
  foldPath,
} from "./protected_paths.ts";
import { assertSha, isRecord, isString } from "./types.ts";
import {
  buildGitArgv,
  type CommandResult,
  type CommandRunner,
  localGitEnv,
} from "./workspace.ts";

export type StaticCheckWorkspace =
  | { kind: "ready"; dir: string; cleanup: () => Promise<void> }
  | { kind: "skipped"; reason: string };

/**
 * 変わっていれば作業木を作らない、依存のマニフェストとlockfile。
 * 検査は基準のlockfileで依存を入れるので、PRが依存を変えると、検査が偽の失敗を出すためである。
 * `.script.lock`はWindmillのscriptの依存で、検査は入れないので含めない。
 */
export const STATIC_CHECK_DEPENDENCY_PATHS: readonly string[] = [
  "package.json",
  "bun.lock",
  "console/package.json",
  "console/bun.lock",
];

/** 依存のファイルが変わったときの、作業木を作らない理由。 */
export const STATIC_CHECK_DEPENDENCY_SKIP_REASON =
  "the change updates dependency files, so the base dependencies cannot check it";

/** 検査が実行するファイルが変わったときの、作業木を作らない理由。 */
export const STATIC_CHECK_EXECUTED_SKIP_REASON =
  "the change updates files the static checks execute, so the base version cannot check it";

/**
 * 重ねずに基準の版を使うパスの一覧。どれかに当たれば重ねない。
 * - `prefixes`: リポジトリのルートからの前方一致。保護パスの禁止接頭辞である。
 * - `executed`: 検査が実行するファイル。`prefixes`は前方一致(lintのスクリプトとその許可リスト)、
 *   `exactPaths`は検査のコマンドが`bun run`で起動するスクリプトから相対importでたどれるファイルである。
 *   これらをPRが変えたら、作業木を作らない。基準の版で検査すると、PRの他のファイルとかみ合わずに偽の失敗を出し、
 *   修正のラウンドでは直せないためである。
 * - `basenamePatterns`: どのディレクトリでも、ファイル名で当てる。道具の設定、依存の解決と読み込む環境変数を変えるファイル、無視の一覧である。
 * - `segments`: どの深さでも、このディレクトリの下を重ねない。PRが入れた依存のコードで、基準の道具を差し替えさせないためである。
 * 照合は、大文字小文字とUnicodeの別名を区別しない(`foldPath`)。
 * `executed`は、`tests/lib/static_check_workspace.test.ts`が、実際のimportをたどって漏れが無いことを確かめる。
 */
export const STATIC_CHECK_NOT_OVERLAID: {
  readonly prefixes: readonly string[];
  readonly executed: {
    readonly prefixes: readonly string[];
    readonly exactPaths: readonly string[];
  };
  readonly basenamePatterns: readonly RegExp[];
  readonly segments: readonly string[];
} = {
  prefixes: [...FORBIDDEN_PATH_PREFIXES],
  executed: {
    prefixes: ["scripts/lint-"],
    exactPaths: [
      "scripts/check-script-locks.ts",
      "scripts/docs-gen.ts",
      "scripts/flow-graph.ts",
      "scripts/launch-graph.ts",
      "scripts/markdown-tree.ts",
      "scripts/ts-tokenize.ts",
      "f/factory/lib/approval_support.ts",
      "f/factory/lib/log.ts",
      "f/factory/lib/prose_check.ts",
      "f/factory/lib/skill_registry.ts",
      "f/factory/lib/types.ts",
    ],
  },
  basenamePatterns: [
    /^\.?biome\.jsonc?$/i,
    /^[jt]sconfig.*\.json$/i,
    /^\.markdownlint/i,
    /^\.textlint/i,
    /^\.?lefthook/i,
    /^\.?bunfig\.toml$/i,
    /^\.?mise(\..+)?\.toml$/i,
    /^\.tool-versions$/i,
    /^wmill\.yaml$/i,
    /^package\.json$/i,
    /^bun\.lockb?$/i,
    /^\.npmrc$/i,
    /^\.(gitignore|ignore|gitattributes|editorconfig)$/i,
    /^\.env(\..*)?$/i,
  ],
  segments: ["node_modules"],
};

const FOLDED_DEPENDENCY_PATHS = STATIC_CHECK_DEPENDENCY_PATHS.map(foldPath);
const FOLDED_PREFIXES = STATIC_CHECK_NOT_OVERLAID.prefixes.map(foldPath);
const FOLDED_EXECUTED_PREFIXES =
  STATIC_CHECK_NOT_OVERLAID.executed.prefixes.map(foldPath);
const FOLDED_EXECUTED_PATHS =
  STATIC_CHECK_NOT_OVERLAID.executed.exactPaths.map(foldPath);
const FOLDED_SEGMENTS = STATIC_CHECK_NOT_OVERLAID.segments.map(foldPath);

/** 作業木を置く場所。検査用のuidがたどれるよう、誰でも入れる`/tmp`の直下に置く。 */
export const STATIC_CHECK_TMP_ROOT = "/tmp";

/**
 * 作業木と、アーカイブの一時のディレクトリの名前の接頭辞。
 * 古いものの掃除(`sweepStaleWorkspaces`)が、この接頭辞で両方を見つける。
 */
export const STATIC_CHECK_DIR_PREFIX = "factory-static-check-";

/** 基準の木のアーカイブを一時に置くディレクトリの名前の接頭辞。展開の後に消す。 */
const ARCHIVE_DIR_PREFIX = `${STATIC_CHECK_DIR_PREFIX}archive-`;

/** `git archive`と`tar`の、1回のtimeoutの既定(ミリ秒)。 */
export const STATIC_CHECK_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 掃除の対象にする、更新から経った時間(ミリ秒)。
 * 作成から後片付けまでの1回の検査より十分に長くし、使っている作業木を消さないようにする。
 */
export const STATIC_CHECK_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/** 作業木を作るコマンドの、出力を保持する上限(バイト)。失敗の理由に末尾を載せるだけなので小さくする。 */
const OUTPUT_MAX_BYTES = 64 * 1024;

/** 失敗の理由に載せる、標準エラーの末尾の字数。 */
const STDERR_TAIL_CHARS = 1_000;

/** 畳み込んだパスが、接頭辞のどれかで始まるか、ディレクトリの名前そのものかを返す。 */
function matchesPrefix(folded: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (prefix) =>
      folded === prefix.replace(/\/$/, "") || folded.startsWith(prefix),
  );
}

/** `path`が、変われば作業木を作らない依存のファイルかを返す。 */
export function isStaticCheckDependencyPath(path: string): boolean {
  return FOLDED_DEPENDENCY_PATHS.includes(foldPath(path));
}

/** `path`が、検査が実行するファイル(`STATIC_CHECK_NOT_OVERLAID.executed`)かを返す。変われば作業木を作らない。 */
export function isStaticCheckExecutedPath(path: string): boolean {
  const folded = foldPath(path);
  return (
    FOLDED_EXECUTED_PATHS.includes(folded) ||
    FOLDED_EXECUTED_PREFIXES.some((prefix) => folded.startsWith(prefix))
  );
}

/** `path`のPRの版を作業木に重ねるかを返す。`STATIC_CHECK_NOT_OVERLAID`のどれかに当たれば偽を返す。 */
export function isStaticCheckOverlaidPath(path: string): boolean {
  const folded = foldPath(path);
  const segments = folded.split("/");
  if (segments.some((segment) => FOLDED_SEGMENTS.includes(segment))) {
    return false;
  }
  if (isStaticCheckExecutedPath(path)) return false;
  if (matchesPrefix(folded, FOLDED_PREFIXES)) return false;
  // 畳み込みで名前の切り出しが変わりうるので、畳み込んだ名前と元の名前の両方に当てる。
  const candidates = [segments.at(-1) ?? folded, path.split("/").pop() ?? path];
  return !STATIC_CHECK_NOT_OVERLAID.basenamePatterns.some((pattern) =>
    candidates.some((candidate) => pattern.test(candidate)),
  );
}

/**
 * 基準のcommit(`baseSha`)の木を`tmpRoot`の下の新しいディレクトリに展開し、PRの変更を重ねて返す。
 * 依存は入れない。検査のコマンドの先頭で、検査の枠の中(非特権のuid、新しいHOME)で入れる。
 * 依存のファイル(`STATIC_CHECK_DEPENDENCY_PATHS`)か、検査が実行するファイル(`isStaticCheckExecutedPath`)が
 * 変わっていれば、何も作らずに`skipped`を返す。
 * 重ねるのは、`isStaticCheckOverlaidPath`が真のパスのうち、worktreeで通常のファイルであるものだけである。
 * worktreeに無いパスは、作業木からも消す。symlink、ディレクトリ、途中にsymlinkを挟むパスは読み飛ばす。
 * 変更のパスが安全でない(絶対パス、`..`、NULなど)ときは、何も作らずに例外を投げる。
 * 作る前に、`tmpRoot`に残った古い作業木を掃除する(`sweepStaleWorkspaces`)。掃除の失敗は`log`に出し、作成は続ける。
 * 途中で失敗したら、作ったディレクトリを消して例外を投げる。
 * 返した`cleanup`は作業木を消す。消せなければ例外を投げる。
 * `.git`は持ち込まないので、検査はgitのフックと設定を読まない。
 */
export async function createStaticCheckWorkspace(input: {
  readonly run: CommandRunner;
  /** `ensureRepo`のclone。`baseSha`のcommitを持つ。 */
  readonly repoDir: string;
  readonly baseSha: string;
  /** PRの変更を読み出すworktree。 */
  readonly worktreeDir: string;
  readonly changes: readonly ChangedPath[];
  /** `git archive`と`tar`の、1回のtimeout。既定は`STATIC_CHECK_COMMAND_TIMEOUT_MS`。 */
  readonly commandTimeoutMs?: number;
  /** 作業木を作る場所。既定は`STATIC_CHECK_TMP_ROOT`。テストで差し替える。 */
  readonly tmpRoot?: string;
  /** 掃除の判定に使う今(エポックからのミリ秒)。既定は`Date.now`。 */
  readonly now?: () => number;
  readonly log?: Logger;
}): Promise<StaticCheckWorkspace> {
  assertSha(input.baseSha);
  const unsafe = input.changes.find((change) => !isSafeRepoPath(change.path));
  if (unsafe !== undefined) {
    throw new Error(
      `static check workspace: unsafe changed path: ${JSON.stringify(displayPath(unsafe.path))}`,
    );
  }
  if (
    input.changes.some((change) => isStaticCheckDependencyPath(change.path))
  ) {
    return { kind: "skipped", reason: STATIC_CHECK_DEPENDENCY_SKIP_REASON };
  }
  if (input.changes.some((change) => isStaticCheckExecutedPath(change.path))) {
    return { kind: "skipped", reason: STATIC_CHECK_EXECUTED_SKIP_REASON };
  }
  const tmpRoot = input.tmpRoot ?? STATIC_CHECK_TMP_ROOT;
  await sweepStaleWorkspaces(
    tmpRoot,
    (input.now ?? Date.now)(),
    input.log ?? logger("static_check_workspace"),
  );
  const dir = await mkdtemp(join(tmpRoot, STATIC_CHECK_DIR_PREFIX));
  try {
    await extractBaseTree({
      run: input.run,
      repoDir: input.repoDir,
      baseSha: input.baseSha,
      dir,
      tmpRoot,
      timeoutMs: input.commandTimeoutMs ?? STATIC_CHECK_COMMAND_TIMEOUT_MS,
    });
    await overlayChanges(input.worktreeDir, dir, input.changes);
  } catch (error) {
    await removeAfterFailure(dir, error);
  }
  return {
    kind: "ready",
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** 作業木を消してから、元の例外を投げ直す。消せなければ、両方の理由を載せた例外を投げる。 */
async function removeAfterFailure(dir: string, error: unknown): Promise<never> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (removeError) {
    throw new Error(
      `${errorMessage(error)} (and the static check workspace ${dir} could not be removed: ${errorMessage(removeError)})`,
      { cause: error },
    );
  }
  throw error;
}

/** 終了コードが0でなければ、標準エラーの末尾を載せた例外を投げる。時間切れなら、その旨を投げる。 */
function assertSucceeded(context: string, result: CommandResult): void {
  if (result.timedOut) {
    throw new Error(`static check workspace: ${context} timed out`);
  }
  if (result.exitCode !== 0) {
    const tail = result.stderr.trim().slice(-STDERR_TAIL_CHARS);
    throw new Error(
      maskSecrets(
        `static check workspace: ${context} failed with exit code ${String(result.exitCode)}: ${tail}`,
      ),
    );
  }
}

/** 渡す環境変数をPATHとジョブのTMPDIRに限る。workerの秘密値と`TAR_OPTIONS`などを子プロセスに渡さないためである。 */
function toolEnv(): Record<string, string> {
  const env: Record<string, string> = { ...jobTmpEnv() };
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  return env;
}

/**
 * `tmpRoot`の直下で、名前が`STATIC_CHECK_DIR_PREFIX`で始まり、更新から`STATIC_CHECK_STALE_AFTER_MS`より古いディレクトリを消す。
 * 取り消しやタイムアウトで後片付けの前に止まった実行が残した、作業木とアーカイブの置き場である。
 * 対象は、symlinkでなく、このプロセスと同じuidが所有するディレクトリに限る。
 * `/tmp`は誰でも書けるので、検査用のuidが置いたものや、検査の枠に渡したままの使用中の作業木に触れないためである。
 * 所有者だけが名前を変えられる(`/tmp`のsticky bit)ので、確かめた後にsymlinkへ差し替えられることもない。
 * 1つも例外にせず、一覧と削除の失敗は`log`の警告に出して先へ進む。消したものは`log`の情報に出す。
 */
async function sweepStaleWorkspaces(
  tmpRoot: string,
  nowMs: number,
  log: Logger,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(tmpRoot);
  } catch (error) {
    log.warn("stale static check workspaces could not be listed", {
      dir: tmpRoot,
      error: errorMessage(error),
    });
    return;
  }
  const uid = process.getuid?.();
  const removed: string[] = [];
  for (const name of names) {
    if (!name.startsWith(STATIC_CHECK_DIR_PREFIX)) continue;
    const path = join(tmpRoot, name);
    try {
      const stats = await lstat(path);
      if (!stats.isDirectory()) continue;
      if (uid !== undefined && stats.uid !== uid) continue;
      if (nowMs - stats.mtimeMs <= STATIC_CHECK_STALE_AFTER_MS) continue;
      await rm(path, { recursive: true, force: true });
      removed.push(name);
    } catch (error) {
      // 同時に動く別の実行が先に消したものは、失敗に数えない。
      if (hasErrorCode(error, MISSING_CODES)) continue;
      log.warn("a stale static check workspace could not be removed", {
        name,
        error: errorMessage(error),
      });
    }
  }
  if (removed.length > 0) {
    log.info("removed stale static check workspaces", { names: removed });
  }
}

/**
 * `baseSha`の木を`dir`に展開する。シェルとパイプを使わず、アーカイブを一時のファイルに書いてから展開する。
 * アーカイブは`mkdtemp`で作る専用のディレクトリに置く。共有の`/tmp`で決まった名前を使うと、
 * 検査用のuidが先に置いたsymlinkの先へ、rootが書き込みうるためである。
 * `tar.umask`で、グループと他人の書き込みの権限を落とす。
 * `git archive`と`tar`には、それぞれ`timeoutMs`を渡す。
 */
async function extractBaseTree(opts: {
  readonly run: CommandRunner;
  readonly repoDir: string;
  readonly baseSha: string;
  readonly dir: string;
  readonly tmpRoot: string;
  readonly timeoutMs: number;
}): Promise<void> {
  const archiveDir = await mkdtemp(join(opts.tmpRoot, ARCHIVE_DIR_PREFIX));
  try {
    const tarPath = join(archiveDir, "base.tar");
    assertSucceeded(
      "git archive",
      await opts.run(
        buildGitArgv([
          "-c",
          "tar.umask=0022",
          "archive",
          "--format=tar",
          `--output=${tarPath}`,
          opts.baseSha,
        ]),
        {
          cwd: opts.repoDir,
          env: localGitEnv(),
          timeoutMs: opts.timeoutMs,
          maxOutputBytes: OUTPUT_MAX_BYTES,
        },
      ),
    );
    assertSucceeded(
      "tar -x",
      await opts.run(
        ["tar", "-x", "--no-same-owner", "-C", opts.dir, "-f", tarPath],
        {
          env: toolEnv(),
          timeoutMs: opts.timeoutMs,
          maxOutputBytes: OUTPUT_MAX_BYTES,
        },
      ),
    );
  } finally {
    await rm(archiveDir, { recursive: true, force: true });
  }
}

type WorktreeSource =
  | { readonly kind: "file"; readonly content: Buffer; readonly mode: number }
  | { readonly kind: "missing" }
  | { readonly kind: "other" };

/** `error`が、`codes`のどれかの`code`を持つかを返す。 */
function hasErrorCode(error: unknown, codes: readonly string[]): boolean {
  return isRecord(error) && isString(error.code) && codes.includes(error.code);
}

/** パスの途中が無いか、ファイルに替わっているときの`code`。 */
const MISSING_CODES = ["ENOENT", "ENOTDIR"] as const;

/**
 * `full`の親を実際のパスに直して返す。親が無ければnullを返す。
 * `realpath`は途中のsymlinkをたどるので、戻り値が`dirname(full)`と違えば、途中にsymlinkがある。
 */
async function realParent(full: string): Promise<string | null> {
  try {
    return await realpath(dirname(full));
  } catch (error) {
    if (hasErrorCode(error, MISSING_CODES)) return null;
    throw error;
  }
}

/**
 * worktreeの`path`を読む。通常のファイルなら中身を、無ければ`missing`を、それ以外は`other`を返す。
 * 途中にsymlinkを挟むパスは`other`にする。worktreeの外のファイルを作業木へ写さないためである。
 * 最後の要素は`O_NOFOLLOW`で開き、symlinkをたどらない。`O_NONBLOCK`で、FIFOを開いて止まらない。
 */
async function readWorktreeFile(
  root: string,
  path: string,
): Promise<WorktreeSource> {
  const full = join(root, path);
  const parent = await realParent(full);
  if (parent === null) return { kind: "missing" };
  if (parent !== dirname(full)) return { kind: "other" };
  let handle: FileHandle;
  try {
    handle = await open(
      full,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (hasErrorCode(error, MISSING_CODES)) return { kind: "missing" };
    if (hasErrorCode(error, ["ELOOP", "EMLINK"])) return { kind: "other" };
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { kind: "other" };
    return {
      kind: "file",
      content: await handle.readFile(),
      mode: (stats.mode & 0o111) !== 0 ? 0o755 : 0o644,
    };
  } finally {
    await handle.close();
  }
}

/** 作業木の`full`の親に、symlinkが挟まっていないことを確かめる。挟まっていれば例外を投げる。 */
function assertNoLinkedParent(full: string, parent: string): void {
  if (parent !== dirname(full)) {
    throw new Error(
      "static check workspace: refusing to write through a symlinked directory in the tree",
    );
  }
}

/**
 * 作業木の`relDir`までのディレクトリを、1段ずつ作る。
 * 既にあるものがディレクトリでなければ例外を投げる。`mkdir`の`recursive`はsymlinkをたどり、作業木の外に作りうるためである。
 */
async function ensureTreeDirs(root: string, relDir: string): Promise<void> {
  let current = root;
  for (const segment of relDir === "." ? [] : relDir.split("/")) {
    current = join(current, segment);
    try {
      if (!(await lstat(current)).isDirectory()) {
        throw new Error(
          "static check workspace: a non-directory blocks an overlaid path in the tree",
        );
      }
    } catch (error) {
      if (!hasErrorCode(error, MISSING_CODES)) throw error;
      await mkdir(current, { mode: 0o755 });
    }
  }
}

/**
 * PRの変更を作業木に重ねる。先にworktreeに無いパスを消し、次に通常のファイルを書く。
 * ディレクトリがファイルに替わった変更で、消した後の場所に書けるようにするためである。
 * 作業木の側は、書く前に途中のsymlinkを確かめ、置き換える前に古いものを消す。
 */
async function overlayChanges(
  worktreeDir: string,
  dir: string,
  changes: readonly ChangedPath[],
): Promise<void> {
  const worktreeRoot = await realpath(worktreeDir);
  const treeRoot = await realpath(dir);
  const sources: { readonly path: string; readonly source: WorktreeSource }[] =
    [];
  for (const change of changes) {
    if (!isStaticCheckOverlaidPath(change.path)) continue;
    sources.push({
      path: change.path,
      source: await readWorktreeFile(worktreeRoot, change.path),
    });
  }
  for (const { path, source } of sources) {
    if (source.kind !== "missing") continue;
    const full = join(treeRoot, path);
    const parent = await realParent(full);
    if (parent === null) continue;
    assertNoLinkedParent(full, parent);
    await rm(full, { recursive: true, force: true });
  }
  for (const { path, source } of sources) {
    if (source.kind !== "file") continue;
    const full = join(treeRoot, path);
    await ensureTreeDirs(treeRoot, dirname(path));
    assertNoLinkedParent(full, await realpath(dirname(full)));
    await rm(full, { recursive: true, force: true });
    await writeFile(full, source.content, { flag: "wx", mode: source.mode });
  }
}
