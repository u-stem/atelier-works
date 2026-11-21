// 保護パスを変えたラウンドの静的検査のために、基準のcommitの木にPRの変更を重ねた一時の作業木を作る。
// 検査の道具、設定、検査が実行するスクリプトは基準の版を使い、PRの版は重ねない。
// PRのファイルを読ませるだけにして、PRのコードを検査に実行させないためである。

import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { displayPath, isSafeRepoPath } from "./ci_fix_paths.ts";
import { jobTmpEnv } from "./job_tmp.ts";
import { errorMessage, maskSecrets } from "./log.ts";
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
 * 作業木は基準のlockfileで依存を入れるので、PRが依存を変えると、検査が偽の失敗を出すためである。
 * `.script.lock`はWindmillのscriptの依存で、作業木には入れないので含めない。
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

/**
 * 重ねずに基準の版を使うパスの一覧。どれかに当たれば重ねない。
 * - `prefixes`: リポジトリのルートからの前方一致。保護パスの禁止接頭辞と、`scripts/lint-`(検査が実行するスクリプトとその許可リスト)。
 * - `exactPaths`: 検査のコマンドが`bun run`で起動するスクリプトから、相対importでたどれるファイル。`scripts/lint-`で始まるものは`prefixes`が持つ。
 * - `basenamePatterns`: どのディレクトリでも、ファイル名で当てる。道具の設定、依存の解決と読み込む環境変数を変えるファイル、無視の一覧である。
 * - `segments`: どの深さでも、このディレクトリの下を重ねない。PRが入れた依存のコードで、基準の道具を差し替えさせないためである。
 * 照合は、大文字小文字とUnicodeの別名を区別しない(`foldPath`)。
 * `exactPaths`は、`tests/lib/static_check_workspace.test.ts`が、実際のimportをたどって漏れが無いことを確かめる。
 */
export const STATIC_CHECK_NOT_OVERLAID: {
  readonly prefixes: readonly string[];
  readonly exactPaths: readonly string[];
  readonly basenamePatterns: readonly RegExp[];
  readonly segments: readonly string[];
} = {
  prefixes: [...FORBIDDEN_PATH_PREFIXES, "scripts/lint-"],
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
const FOLDED_EXACT_PATHS = STATIC_CHECK_NOT_OVERLAID.exactPaths.map(foldPath);
const FOLDED_SEGMENTS = STATIC_CHECK_NOT_OVERLAID.segments.map(foldPath);

/** 作業木を置く場所。検査用のuidがたどれるよう、誰でも入れる`/tmp`の直下に置く。 */
export const STATIC_CHECK_TMP_ROOT = "/tmp";

/** 作業木のディレクトリの名前の接頭辞。 */
export const STATIC_CHECK_DIR_PREFIX = "factory-static-check-";

/** 基準の木のアーカイブを一時に置くディレクトリの名前の接頭辞。展開の後に消す。 */
const ARCHIVE_DIR_PREFIX = "factory-static-archive-";

/** 作業木を作るコマンドの、出力を保持する上限(バイト)。失敗の理由に末尾を載せるだけなので小さくする。 */
const OUTPUT_MAX_BYTES = 64 * 1024;

/** 失敗の理由に載せる、標準エラーの末尾の字数。 */
const STDERR_TAIL_CHARS = 1_000;

/** `path`が、変われば作業木を作らない依存のファイルかを返す。 */
export function isStaticCheckDependencyPath(path: string): boolean {
  return FOLDED_DEPENDENCY_PATHS.includes(foldPath(path));
}

/** `path`のPRの版を作業木に重ねるかを返す。`STATIC_CHECK_NOT_OVERLAID`のどれかに当たれば偽を返す。 */
export function isStaticCheckOverlaidPath(path: string): boolean {
  const folded = foldPath(path);
  const segments = folded.split("/");
  if (segments.some((segment) => FOLDED_SEGMENTS.includes(segment))) {
    return false;
  }
  if (FOLDED_EXACT_PATHS.includes(folded)) return false;
  if (
    FOLDED_PREFIXES.some(
      (prefix) =>
        folded === prefix.replace(/\/$/, "") || folded.startsWith(prefix),
    )
  ) {
    return false;
  }
  // 畳み込みで名前の切り出しが変わりうるので、畳み込んだ名前と元の名前の両方に当てる。
  const candidates = [segments.at(-1) ?? folded, path.split("/").pop() ?? path];
  return !STATIC_CHECK_NOT_OVERLAID.basenamePatterns.some((pattern) =>
    candidates.some((candidate) => pattern.test(candidate)),
  );
}

/**
 * 基準のcommit(`baseSha`)の木を`tmpRoot`の下の新しいディレクトリに展開し、依存を入れ、PRの変更を重ねて返す。
 * 依存のファイル(`STATIC_CHECK_DEPENDENCY_PATHS`)が変わっていれば、何も作らずに`skipped`を返す。
 * 重ねるのは、`isStaticCheckOverlaidPath`が真のパスのうち、worktreeで通常のファイルであるものだけである。
 * worktreeに無いパスは、作業木からも消す。symlink、ディレクトリ、途中にsymlinkを挟むパスは読み飛ばす。
 * 変更のパスが安全でない(絶対パス、`..`、NULなど)ときは、何も作らずに例外を投げる。
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
  readonly installTimeoutMs: number;
  /** 作業木を作る場所。既定は`STATIC_CHECK_TMP_ROOT`。テストで差し替える。 */
  readonly tmpRoot?: string;
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
  const tmpRoot = input.tmpRoot ?? STATIC_CHECK_TMP_ROOT;
  const dir = await mkdtemp(join(tmpRoot, STATIC_CHECK_DIR_PREFIX));
  try {
    await extractBaseTree(
      input.run,
      input.repoDir,
      input.baseSha,
      dir,
      tmpRoot,
    );
    await installDependencies(input.run, dir, input.installTimeoutMs);
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

/** 渡す環境変数をPATHとHOMEとジョブのTMPDIRに限る。workerの秘密値を子プロセスに渡さないためである。 */
function toolEnv(): Record<string, string> {
  const env: Record<string, string> = { ...jobTmpEnv() };
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
  return env;
}

/**
 * `baseSha`の木を`dir`に展開する。シェルとパイプを使わず、アーカイブを一時のファイルに書いてから展開する。
 * アーカイブは`mkdtemp`で作る専用のディレクトリに置く。共有の`/tmp`で決まった名前を使うと、
 * 検査用のuidが先に置いたsymlinkの先へ、rootが書き込みうるためである。
 * `tar.umask`で、グループと他人の書き込みの権限を落とす。
 */
async function extractBaseTree(
  run: CommandRunner,
  repoDir: string,
  baseSha: string,
  dir: string,
  tmpRoot: string,
): Promise<void> {
  const archiveDir = await mkdtemp(join(tmpRoot, ARCHIVE_DIR_PREFIX));
  try {
    const tarPath = join(archiveDir, "base.tar");
    assertSucceeded(
      "git archive",
      await run(
        buildGitArgv([
          "-c",
          "tar.umask=0022",
          "archive",
          "--format=tar",
          `--output=${tarPath}`,
          baseSha,
        ]),
        { cwd: repoDir, env: localGitEnv(), maxOutputBytes: OUTPUT_MAX_BYTES },
      ),
    );
    assertSucceeded(
      "tar -x",
      await run(["tar", "-x", "--no-same-owner", "-C", dir, "-f", tarPath], {
        env: toolEnv(),
        maxOutputBytes: OUTPUT_MAX_BYTES,
      }),
    );
  } finally {
    await rm(archiveDir, { recursive: true, force: true });
  }
}

/**
 * 基準のlockfileで依存を入れる。lockfileを書き換えず、install scriptを実行しない。
 * rootが実行するので、bunのキャッシュはworkerのHOMEのものを使う。
 */
async function installDependencies(
  run: CommandRunner,
  dir: string,
  timeoutMs: number,
): Promise<void> {
  assertSucceeded(
    "bun install",
    await run(["bun", "install", "--frozen-lockfile", "--ignore-scripts"], {
      cwd: dir,
      env: toolEnv(),
      timeoutMs,
      maxOutputBytes: OUTPUT_MAX_BYTES,
    }),
  );
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
