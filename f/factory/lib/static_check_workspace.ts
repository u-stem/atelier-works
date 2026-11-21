// 静的検査(実装フローの保護パスを変えたラウンドと、PR修正フローの検証)のために、基準のcommitの木にPRの変更を重ねた一時の作業木を作る。
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
import { isSafeRepoPath } from "./ci_fix_paths.ts";
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

/**
 * 静的検査のコマンドの前に、作業木で実行する依存の導入。
 * 作業木は基準の版のlockfileを持つので、`--frozen-lockfile`で基準の依存をそのまま入れる。
 * `--ignore-scripts`で、依存のinstallのスクリプトを実行しない。
 */
export const STATIC_CHECK_INSTALL_COMMAND =
  "bun install --frozen-lockfile --ignore-scripts";

/** 依存のファイルが変わったときの、作業木を作らない理由。 */
export const STATIC_CHECK_DEPENDENCY_SKIP_REASON =
  "the change updates dependency files, so the base dependencies cannot check it";

/** 検査が実行するファイルが変わったときの、作業木を作らない理由。 */
export const STATIC_CHECK_EXECUTED_SKIP_REASON =
  "the change updates files the static checks execute, so the base version cannot check it";

/** 作業木に安全に写せない名前のパスが変わったときの、作業木を作らない理由。 */
export const STATIC_CHECK_UNSAFE_PATH_SKIP_REASON =
  "the change has a path that cannot be copied into the workspace safely";

/** 作業木の直下で、gitがgitのディレクトリとして読みうる名前のパスが変わったときの、作業木を作らない理由。 */
export const STATIC_CHECK_GITDIR_SKIP_REASON =
  "the change has a top-level path that git could read as a repository";

/** 静的検査が基準の版に固定しない道具の設定が変わったときの、作業木を作らない理由。 */
export const STATIC_CHECK_UNCHECKED_CONFIG_SKIP_REASON =
  "the change updates a tool configuration the static checks do not pin to the base version";

/**
 * 作業木の直下(パスの先頭の要素)にあると、gitが作業木をgitのディレクトリとして読みうる名前。畳み込んだ(`foldPath`)形で持つ。
 * `HEAD`、`config`、`objects/`、`refs/`がそろうと、gitはそのディレクトリをbareのリポジトリとして使い、
 * その`config`に書かれたコマンド(`core.fsmonitor`など)を実行しうる。
 * 残りは、gitがgitのディレクトリの中で読むファイルとディレクトリである。
 * 1つでも変われば、作業木を作らない。検査の環境は`safe.bareRepository=explicit`でも止める(`checkEnv`)。
 */
export const STATIC_CHECK_GITDIR_NAMES: readonly string[] = [
  "head",
  "config",
  "objects",
  "refs",
  "packed-refs",
  "commondir",
  "gitdir",
  "index",
  "info",
  "hooks",
  "worktrees",
  "modules",
];

/** 作業木の直下の`.git`と、末尾に点や空白を付けた別名。畳み込んだ形に当てる。 */
const DOT_GIT_NAME = /^\.git[. ]*$/;

/**
 * 変われば作業木を作らない、静的検査が基準の版に固定しない道具の設定のファイル名。どのディレクトリでも当てる。
 * 実装フローの保護パスのファイル名の規則(`IMPLEMENT_PROTECTED_BASENAME_PATTERNS`)のうち、
 * ファイル名だけで、道具の設定、道具が読み込んで実行するコード、依存の定義と決まり、
 * `STATIC_CHECK_NOT_OVERLAID`で基準の版を使っていないものを選んだ。
 * 静的検査の道具(Biome、tsc、`bun run scripts/...`)はこれらを読まないが、PRの版を重ねると、
 * 一覧に無い道具を設定に足したときに、その道具がPRの設定やコードを読む。基準の版を使うと偽の失敗になるので、どちらもせずに飛ばす。
 * `CODEOWNERS`は、道具が設定として読まないので選ばない。
 * ディレクトリで決まる保護パス(`.husky/`など)、テスト、文書、`scripts/`(`lint-`で始まるものを除く)も選ばない。
 * 静的検査がそれらを常に飛ばすと、保護パスを変えたラウンドで検査する意味が無くなるためである。
 * 分類は`tests/lib/static_check_workspace.test.ts`が、実装の保護パスの規則ごとに固定する。
 */
export const STATIC_CHECK_UNCHECKED_CONFIG_PATTERNS: readonly RegExp[] = [
  /^wmill\.yml$/i,
  /^\.gitmodules$/i,
  /^\.(node|bun|python)-version$/i,
  /^\.nvmrc$/i,
  /^rust-toolchain(\.toml)?$/i,
  /^\.gitleaks(ignore|\.toml)$/i,
  /^\.yarnrc(\.yml)?$/i,
  /^\.pnpmfile\.cjs$/i,
  /^(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/i,
  /^[\w.-]+\.config\.[cm]?[jt]s$/i,
  /^\.(eslintrc|babelrc|prettierrc)(\..*)?$/i,
  /^(makefile|justfile|taskfile\.ya?ml|turbo\.json|nx\.json|deno\.jsonc?|\.pre-commit-config\.yaml)$/i,
  /^(uv|poetry)\.lock$/i,
  /^pipfile(\.lock)?$/i,
  /^pyproject\.toml$/i,
  /^setup\.(py|cfg)$/i,
  /^requirements.*\.txt$/i,
  /^cargo\.(lock|toml)$/i,
  /^go\.(sum|mod)$/i,
  /^gemfile(\.lock)?$/i,
  /^composer\.(lock|json)$/i,
];

/** 依存の導入が失敗したときの、静的検査を飛ばす理由。 */
export const STATIC_CHECK_INSTALL_FAILED_REASON =
  "the base dependencies could not be installed";

/** 1件あたりの打ち切りが下限に届かないときの、静的検査を飛ばす理由。 */
export const STATIC_CHECK_TIMEOUT_TOO_SHORT_REASON =
  "the time of one check command is too short to share among the static check commands";

/** 静的検査の依存の導入と設定のコマンドの、1件あたりの打ち切りの下限(ミリ秒)。これより短いと、1件も意味のある検査を終えられない。 */
export const STATIC_CHECK_MIN_COMMAND_TIMEOUT_MS = 30_000;

/**
 * 静的検査の依存の導入と設定のコマンドの、1件あたりの打ち切り(ミリ秒)を返す。
 * 時間の見積もりは静的検査を検査コマンド1件分(打ち切り`budgetMs`と停止の上乗せ`stopOverheadMs`)と数えるので、
 * その1件分を、依存の導入と`commandCount`件のコマンドで等分する。
 * 各件が打ち切りまでかかり、それぞれに停止の上乗せが付いても、合計は`budgetMs + stopOverheadMs`を超えない。
 * 1件あたりが下限`STATIC_CHECK_MIN_COMMAND_TIMEOUT_MS`に届かなければnullを返し、呼び出し側は静的検査を飛ばす。
 * 下限で打ち切りを延ばすと、合計が見積もりの1件分を超えるためである。
 * 作業木を作るコマンド(`git archive`、`tar`、`git init`、`git add`)は、この1件分に含めず、`STATIC_CHECK_WORKSPACE_WORST_CASE_SEC`として見積もりに足す。
 */
export function staticCheckCommandTimeoutMs(
  budgetMs: number,
  stopOverheadMs: number,
  commandCount: number,
): number | null {
  const share =
    Math.floor((budgetMs + stopOverheadMs) / (commandCount + 1)) -
    stopOverheadMs;
  return share < STATIC_CHECK_MIN_COMMAND_TIMEOUT_MS ? null : share;
}

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

/**
 * 作業木を作る間だけ使う一時のディレクトリの名前の接頭辞。基準の木のアーカイブと、gitを実行するときのHOMEを置く。
 * 作業木を作り終えたら消す。
 */
const SCRATCH_DIR_PREFIX = `${STATIC_CHECK_DIR_PREFIX}scratch-`;

/**
 * 作業木を作るコマンド(`git archive`、`tar`、`git init`、`git add`)の、1回のtimeoutの既定(ミリ秒)。
 * どれもローカルの読み書きだけで、ネットワークを使わない。
 */
export const STATIC_CHECK_COMMAND_TIMEOUT_MS = 2 * 60 * 1000;

/** 作業木を作るコマンドの数。 */
const WORKSPACE_COMMAND_COUNT = 4;

/** 作業木を作るコマンドが、timeoutの後に上乗せしうる停止と出力待ちの時間(秒)。ランナーの最大13秒を切り上げた値。 */
const WORKSPACE_COMMAND_STOP_OVERHEAD_SEC = 15;

/**
 * 作業木の作成(`git archive`、`tar`、`git init`、`git add`)の最悪の所要時間(秒)。
 * 時間の見積もりは、静的検査を1回実行するごとに、検査コマンド1件分にこの値を足す。
 * 既定のtimeoutの4回分と、それぞれの停止の上乗せである。
 */
export const STATIC_CHECK_WORKSPACE_WORST_CASE_SEC =
  WORKSPACE_COMMAND_COUNT *
  (STATIC_CHECK_COMMAND_TIMEOUT_MS / 1000 +
    WORKSPACE_COMMAND_STOP_OVERHEAD_SEC);

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

/** 照合に使うファイル名。畳み込みで名前の切り出しが変わりうるので、畳み込んだパスの名前と元の名前の両方を返す。 */
function basenameCandidates(path: string): string[] {
  const folded = foldPath(path);
  return [folded.split("/").pop() ?? folded, path.split("/").pop() ?? path];
}

/** `path`の先頭の要素が、gitがgitのディレクトリとして読みうる名前(`STATIC_CHECK_GITDIR_NAMES`か`.git`)かを返す。 */
export function isStaticCheckGitdirPath(path: string): boolean {
  const top = foldPath(path).split("/")[0] ?? "";
  return STATIC_CHECK_GITDIR_NAMES.includes(top) || DOT_GIT_NAME.test(top);
}

/** `path`が、静的検査が基準の版に固定しない道具の設定(`STATIC_CHECK_UNCHECKED_CONFIG_PATTERNS`)かを返す。 */
export function isStaticCheckUncheckedConfigPath(path: string): boolean {
  const candidates = basenameCandidates(path);
  return STATIC_CHECK_UNCHECKED_CONFIG_PATTERNS.some((pattern) =>
    candidates.some((candidate) => pattern.test(candidate)),
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
  const candidates = basenameCandidates(path);
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
 * 変更のパスが安全に写せない形(`isSafeRepoPath`を通らない。絶対パス、`..`、NUL、バックスラッシュ、不可視文字、
 * NFKCで変わる文字など)のときも、何も作らずに`skipped`を返す。
 * そのパスだけを重ねずに検査すると、作業木がPRの版と食い違い、修正のラウンドで直せない偽の失敗か、
 * 検査していないファイルを含んだまま検査に通ったという結果を出すためである。
 * 作業木の直下でgitがgitのディレクトリとして読みうる名前のパス(`isStaticCheckGitdirPath`)と、
 * 基準の版に固定しない道具の設定(`isStaticCheckUncheckedConfigPath`)が変わったときも、何も作らずに`skipped`を返す。
 * 作る前に、`tmpRoot`に残った古い作業木を掃除する(`sweepStaleWorkspaces`)。掃除の失敗は`log`に出し、作成は続ける。
 * 重ねた後、作業木に新しい`.git`を作り、作業木のファイルを索引に入れる(`indexTree`)。
 * cloneの`.git`は持ち込まないので、検査はcloneのフックと設定を読まない。
 * 途中で失敗したら、作ったディレクトリを消して例外を投げる。
 * 返した`cleanup`は作業木を消す。消せなければ例外を投げる。
 */
export async function createStaticCheckWorkspace(input: {
  readonly run: CommandRunner;
  /** `ensureRepo`のclone。`baseSha`のcommitを持つ。 */
  readonly repoDir: string;
  readonly baseSha: string;
  /** PRの変更を読み出すworktree。 */
  readonly worktreeDir: string;
  readonly changes: readonly ChangedPath[];
  /** 作業木を作るコマンドの、1回のtimeout。既定は`STATIC_CHECK_COMMAND_TIMEOUT_MS`。 */
  readonly commandTimeoutMs?: number;
  /** 作業木を作る場所。既定は`STATIC_CHECK_TMP_ROOT`。テストで差し替える。 */
  readonly tmpRoot?: string;
  /** 掃除の判定に使う今(エポックからのミリ秒)。既定は`Date.now`。 */
  readonly now?: () => number;
  readonly log?: Logger;
}): Promise<StaticCheckWorkspace> {
  assertSha(input.baseSha);
  const skipReason = skipReasonFor(input.changes);
  if (skipReason !== null) return { kind: "skipped", reason: skipReason };
  const tmpRoot = input.tmpRoot ?? STATIC_CHECK_TMP_ROOT;
  await sweepStaleWorkspaces(
    tmpRoot,
    (input.now ?? Date.now)(),
    input.log ?? logger("static_check_workspace"),
  );
  const timeoutMs = input.commandTimeoutMs ?? STATIC_CHECK_COMMAND_TIMEOUT_MS;
  const dir = await mkdtemp(join(tmpRoot, STATIC_CHECK_DIR_PREFIX));
  try {
    const scratch = await mkdtemp(join(tmpRoot, SCRATCH_DIR_PREFIX));
    try {
      await extractBaseTree({
        run: input.run,
        repoDir: input.repoDir,
        baseSha: input.baseSha,
        dir,
        tarPath: join(scratch, "base.tar"),
        timeoutMs,
      });
      await overlayChanges(input.worktreeDir, dir, input.changes);
      await indexTree({ run: input.run, dir, home: scratch, timeoutMs });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  } catch (error) {
    await removeAfterFailure(dir, error);
  }
  return {
    kind: "ready",
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** 変更の一覧から、作業木を作らない理由を返す。作ってよければnullを返す。 */
function skipReasonFor(changes: readonly ChangedPath[]): string | null {
  const any = (predicate: (path: string) => boolean): boolean =>
    changes.some((change) => predicate(change.path));
  if (any((path) => !isSafeRepoPath(path))) {
    return STATIC_CHECK_UNSAFE_PATH_SKIP_REASON;
  }
  if (any(isStaticCheckGitdirPath)) return STATIC_CHECK_GITDIR_SKIP_REASON;
  if (any(isStaticCheckDependencyPath)) {
    return STATIC_CHECK_DEPENDENCY_SKIP_REASON;
  }
  if (any(isStaticCheckExecutedPath)) return STATIC_CHECK_EXECUTED_SKIP_REASON;
  if (any(isStaticCheckUncheckedConfigPath)) {
    return STATIC_CHECK_UNCHECKED_CONFIG_SKIP_REASON;
  }
  return null;
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
 * 取り消しやタイムアウトで後片付けの前に止まった実行が残した、作業木と、アーカイブとHOMEの置き場である。
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
 * `baseSha`の木を`dir`に展開する。シェルとパイプを使わず、アーカイブを一時のファイル`tarPath`に書いてから展開する。
 * `tarPath`は`mkdtemp`で作る専用のディレクトリに置く。共有の`/tmp`で決まった名前を使うと、
 * 検査用のuidが先に置いたsymlinkの先へ、rootが書き込みうるためである。
 * `tar.umask`で、グループと他人の書き込みの権限を落とす。
 * `git archive`と`tar`には、それぞれ`timeoutMs`を渡す。
 */
async function extractBaseTree(opts: {
  readonly run: CommandRunner;
  readonly repoDir: string;
  readonly baseSha: string;
  readonly dir: string;
  readonly tarPath: string;
  readonly timeoutMs: number;
}): Promise<void> {
  assertSucceeded(
    "git archive",
    await opts.run(
      buildGitArgv([
        "-c",
        "tar.umask=0022",
        "archive",
        "--format=tar",
        `--output=${opts.tarPath}`,
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
      ["tar", "-x", "--no-same-owner", "-C", opts.dir, "-f", opts.tarPath],
      {
        env: toolEnv(),
        timeoutMs: opts.timeoutMs,
        maxOutputBytes: OUTPUT_MAX_BYTES,
      },
    ),
  );
}

/**
 * 作業木`dir`に新しい`.git`を作り、作業木のファイルをすべて索引に入れる。
 * 検査のスクリプトは`git ls-files`で対象のファイルを列挙するので、`.git`の無い木では失敗するためである。
 * rootが、作業木を検査用のuidに渡す前に実行する。
 * gitは`GIT_DIR`と`GIT_WORK_TREE`で作業木の`.git`を名指しし、作業木の中のファイルをgitのディレクトリとして探させない。
 * 読む設定は、`git init`が作る`.git/config`と、`buildGitArgv`と`-c`で固定する値だけである。
 * グローバルとシステムの設定は読まない(`localGitEnv`)。HOMEは`home`(作業木を作る間だけの一時のディレクトリ)にする。
 * `--template=`で、テンプレートのフックと`info/`を写さない。
 * `git add`は、ファイルの中身と属性(`.gitattributes`)と無視の一覧(`.gitignore`)を読んで索引とオブジェクトを書くだけで、コードを実行しない。
 * 中身を変換する`filter`と`core.fsmonitor`はコマンドを実行しうるが、`filter`の定義は読む設定のどこにも無く、`core.fsmonitor`は`false`に固定する。
 * 作業木の`.gitattributes`と`.gitignore`は、PRの版を重ねない(`STATIC_CHECK_NOT_OVERLAID`)ので基準の版である。
 * PRは`.git`の下にファイルを置けない(`isSafeRepoPath`が`.git`の要素を拒む)。
 */
async function indexTree(opts: {
  readonly run: CommandRunner;
  readonly dir: string;
  readonly home: string;
  readonly timeoutMs: number;
}): Promise<void> {
  const env = {
    ...localGitEnv(opts.home),
    GIT_DIR: join(opts.dir, ".git"),
    GIT_WORK_TREE: opts.dir,
  };
  const fixed = [
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.safecrlf=false",
    "-c",
    "init.defaultBranch=main",
  ];
  const steps: readonly (readonly [string, readonly string[]])[] = [
    ["git init", ["init", "-q", "--template="]],
    ["git add", ["add", "-A"]],
  ];
  for (const [context, args] of steps) {
    assertSucceeded(
      context,
      await opts.run(buildGitArgv([...fixed, ...args]), {
        cwd: opts.dir,
        env,
        timeoutMs: opts.timeoutMs,
        maxOutputBytes: OUTPUT_MAX_BYTES,
      }),
    );
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
