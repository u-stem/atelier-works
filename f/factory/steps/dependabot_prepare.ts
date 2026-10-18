// f/factory/dependabotフローの準備ステップ。
// 作業項目のPRについて事実を集め直してゲートを評価し、通ればheadのshaに固定したきれいな作業ツリーを作り、
// ルートとconsole/の依存を隔離した環境でインストールする。
// インストールの後に、作業ツリーがきれいなままであること、インストールしたパッケージのスクリプトが
// registryの値と一致することを確かめ、影響調査のステップに渡す成果物を組み立てる。
// 状態は`picked`のまま返す。終端にするのは、取り消すときと人に回すときだけである。

import * as wmill from "windmill-client@1.817.0";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  type CheckCommandResult,
  runAllowedCheckCommands,
} from "../lib/check_runner.ts";
import {
  CheckEnvironmentError,
  type CheckSandbox,
  checkSandboxFromEnv,
} from "../lib/check_sandbox.ts";
import { loadConfig } from "../lib/config.ts";
import {
  addNoticeUnlessUnresolved,
  getWorkItem,
  updateStatusIfCurrent,
} from "../lib/db.ts";
import {
  buildCollectDeps,
  type CollectDeps,
  type CollectedPackage,
  type CollectResult,
  collectGateInput,
  LOCKFILE_PATHS,
} from "../lib/dependabot_collect.ts";
import {
  buildLockfileSummary,
  buildManifestDiffSummary,
  changelogCoversVersion,
  checkPromptSize,
  compareInstalledScripts,
  compareRepositoryUrls,
  DEPENDABOT_INSTALL_TIMEOUT_MS,
  dependabotReason,
  evaluatePostInstallStatus,
  excerptChangelog,
  hasTruncationMark,
  MAX_SUMMARY_CHARS,
  OTHER_REPO_UNSUPPORTED_REASON,
  POST_INSTALL_STATUS_ARGV,
  sanitizeUntrustedProse,
} from "../lib/dependabot_flow_support.ts";
import {
  type DependabotPromptInput,
  type DependabotPromptPackage,
  effectiveUnverifiedInputs,
  type UnverifiedInputName,
} from "../lib/dependabot_prompt.ts";
import { MAX_METADATA_CHARS } from "../lib/dependabot_registry.ts";
import {
  evaluateGateGroup,
  type GateInput,
  type GateTargetFacts,
  type RepoPolicy,
  resolveRepoPolicy,
} from "../lib/dependabot_support.ts";
import { type NotifyEvent, notifyBestEffort } from "../lib/discord.ts";
import {
  type GhClient,
  GitHubHttpError,
  type PullRequest,
} from "../lib/github.ts";
import { recordCheckEnvironmentNotice } from "../lib/host_action.ts";
import { logger, maskSecrets } from "../lib/log.ts";
import { isCommitSha } from "../lib/main_ci_support.ts";
import {
  repoOwnerGateDeps,
  repoOwnerStopReason,
} from "../lib/repo_owner_gate.ts";
import {
  assertGitHubName,
  type FactoryConfig,
  type WorkItem,
} from "../lib/types.ts";
import {
  addDetachedWorktree,
  assertWorktreeGitPointer,
  buildGitArgv,
  type CommandRunner,
  ensureRepo,
  fetchPrHeadRef,
  listWorktrees,
  localGitEnv,
  readAndVerifyWorktreeGitPointer,
  removeWorktree,
  runCommand,
  type WorktreeEntry,
  WorktreeGitPointerModifiedError,
} from "../lib/workspace.ts";
import { describeReason, nextActionFor } from "./pr_workflow_support.ts";

// ---- 状態の注記 ----

/**
 * 通知せずに取り消すときの注記(`status_reason`)。
 * - `disabled`: `dependabot_enabled`が偽。
 * - `prClosed`: PRが閉じたかマージされた。
 * - `headMoved`: 取得が作業項目を作った後に、PRのheadが動いた。新しいheadは取得が別の作業項目で拾う。
 * - `gateWaiting`: ゲートか収集が待ちを返した。待つのは取得の役目なので、フローは終える。
 */
export const DEPENDABOT_CANCEL_NOTE = {
  disabled: "dependabot_disabled",
  prClosed: "pr_closed",
  headMoved: "head_moved",
  gateWaiting: "gate_waiting",
} as const;

// ---- 結果 ----

/** 影響調査のステップが受け取る成果物。文字列はすべて無害化してある。 */
export type DependabotAssessInput = {
  readonly workItemId: number;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  /** 事実を集め、作業ツリーを固定したheadのsha。マージの直前に、PRのheadがこれと同じかを確かめる。 */
  readonly headSha: string;
  /** PRのbaseのブランチ名。収集が`main`であることを確かめている。 */
  readonly baseRef: string;
  /** 収集で比較に使ったbaseのブランチの先頭のsha。 */
  readonly baseSha: string;
  readonly mergeBaseSha: string;
  readonly repoDir: string;
  /** headのshaのdetachedの作業ツリー。インストール済みで、インストール先(`node_modules`と`vendor`、console/の下も含む)のほかに追跡外のファイルが無い。 */
  readonly worktreeDir: string;
  /**
   * 更新の対象。名前の辞書順で、1個以上`MAX_GROUP_TARGETS`個以下。
   * 名前は`registry`の名前と一致し、版は`x.y.z`の形である(ゲートが確かめている)。
   * `promptInput.packages`と同じ順で並ぶ。
   */
  readonly targets: readonly {
    readonly name: string;
    readonly from: string;
    readonly to: string;
  }[];
  /**
   * `buildDependabotPrompt`にそのまま渡す入力。
   * 外部由来の文字列は`sanitizeUntrustedProse`を通してある。
   * `unverifiedInputs`は`effectiveUnverifiedInputs`を適用した後の一覧で、空でなければ人に回す。
   */
  readonly promptInput: DependabotPromptInput;
  /**
   * 機械の検査が見つけたサプライチェーンの懸念。無害化した英語の文である。
   * repositoryのURLが同じ場所を指すと確かめられないとき(読めない、解釈できないときも含む)に1件入る。
   * 結論を出すときは、Claudeの`supplyChainConcerns`に足してから`decideImpactOutcome`に渡す。1件でもあれば人に回る。
   */
  readonly machineConcerns: string[];
};

/**
 * 影響調査の結果に関わらず、人に回す根拠の一覧を返す。空なら根拠は無い。
 * 未確認の入力(`promptInput.unverifiedInputs`)と機械の懸念(`machineConcerns`)を1つにまとめる。
 * 2つは別々の用途(プロンプトと`decideImpactOutcome`)にも使うので、成果物には分けて持ち、まとめるのはこの関数に限る。
 */
export function escalationsOf(assess: DependabotAssessInput): string[] {
  return [
    ...assess.promptInput.unverifiedInputs.map(
      (name) => `unverified input: ${name}`,
    ),
    ...assess.machineConcerns,
  ];
}

/** 影響調査に進むときの結果。 */
export type DependabotPrepareProceed = {
  readonly proceed: true;
  readonly terminalStatus: null;
  readonly reason: null;
  readonly workItemId: number;
  readonly assess: DependabotAssessInput;
};

/** 影響調査に進まないときの結果。 */
export type DependabotPrepareStopped = {
  readonly proceed: false;
  /** このステップが作業項目を終端にしたときの状態。状態を変えずに終えたとき(ほかの処理が先に動かしたときも)は`null`。 */
  readonly terminalStatus: "cancelled" | "needs_human" | null;
  /** 進まない理由。状態を変えたときは状態の注記と同じ文字列。 */
  readonly reason: string;
  readonly workItemId: number;
  readonly assess: null;
};

export type DependabotPrepareResult =
  | DependabotPrepareProceed
  | DependabotPrepareStopped;

// ---- 依存 ----

export type DependabotPrepareWorkItem = Pick<
  WorkItem,
  "id" | "kind" | "status" | "owner" | "repo" | "pr_number" | "head_sha"
>;

export type DependabotPrepareInput = {
  readonly workItem: DependabotPrepareWorkItem;
  readonly dependabotEnabled: boolean;
  /** `factory_config`の`dependabot_group_enabled`。偽なら、2つ以上のパッケージが変わるPRをゲートが止める。 */
  readonly groupEnabled: boolean;
  /**
   * このリポジトリの扱い。`primary`以外は、cloneもインストールもせずに、ゲートの後で人に回す。
   * `off`は収集が先に止めるので、ここに届くのは設定が収集の後に変わったときだけである。
   */
  readonly repoPolicy: RepoPolicy;
  readonly instanceName: string;
};

/** 収集の結果と、収集が最後に読んだPR(タイトルと本文に使う)。PRを読めなかったときは`null`。 */
export type CollectOutcome = {
  readonly result: CollectResult;
  readonly pr: PullRequest | null;
};

export type PreparedWorktree = {
  readonly repoDir: string;
  readonly worktreeDir: string;
  /** 作った直後に検証した`<worktreeDir>/.git`の中身。作業ツリーでgitを実行する前に、これと比べる。 */
  readonly gitPointer: string;
};

export type InstalledPackage = {
  readonly packageJson: unknown;
  readonly hasBindingGyp: boolean;
};

/** `runDependabotPrepare`が使うI/O。テストでは偽物に差し替える。 */
export type DependabotPrepareDeps = {
  /** PRの事実を集め直す(`collectGateInput`)。 */
  readonly collect: () => Promise<CollectOutcome>;
  /**
   * リポジトリを取得する前に、リポジトリのオーナーの数値IDを照合する(`repoOwnerStopReason`)。
   * 通るときは`null`、止めるときはその理由を返す。取得の失敗(404以外)は例外を投げる。
   */
  readonly ensureRepoOwner: (
    owner: string,
    repo: string,
  ) => Promise<string | null>;
  /** headのshaのdetachedの作業ツリーを作り直す(`recreateDependabotWorktree`)。 */
  readonly createWorktree: (headSha: string) => Promise<PreparedWorktree>;
  readonly removeWorktree: (worktree: PreparedWorktree) => Promise<void>;
  /** ルートとconsole/のインストールを、隔離した環境で実行する(`runDependabotInstall`)。 */
  readonly runInstall: (
    worktreeDir: string,
  ) => Promise<readonly CheckCommandResult[]>;
  /** workerが隔離の前提を満たさないとき、運用者に直し方を示す通知を残す。 */
  readonly reportCheckEnvironment: (
    error: CheckEnvironmentError,
  ) => Promise<void>;
  /** `.git`が`expected`と一致しなければ`WorktreeGitPointerModifiedError`を投げる。 */
  readonly assertGitPointer: (
    worktreeDir: string,
    expected: string,
  ) => Promise<void>;
  /** インストール後の`git status`を実行する。 */
  readonly run: CommandRunner;
  /** `<worktreeDir>/<packageDir>`のpackage.jsonとbinding.gypを読む(`readInstalledPackageFrom`)。 */
  readonly readInstalledPackage: (
    worktreeDir: string,
    packageDir: string,
  ) => Promise<InstalledPackage | null>;
  /** `<worktreeDir>/<packageDir>`の変更履歴を読む(`readChangelogFrom`)。 */
  readonly readChangelog: (
    worktreeDir: string,
    packageDir: string,
  ) => Promise<string | null>;
  readonly updateStatus: (
    id: number,
    from: "picked",
    to: "cancelled" | "needs_human",
    note: string,
  ) => Promise<boolean>;
  readonly notify: (event: NotifyEvent) => Promise<void>;
  readonly warn: (message: string, fields: Record<string, unknown>) => void;
};

// ---- 上限 ----

const PR_TITLE_MAX_CHARS = 300;
const PR_BODY_MAX_CHARS = 16_000;
/** 変更履歴の抜粋の上限(`buildChangelogExcerpt`の既定のバイト数と同じ)。 */
const CHANGELOG_MAX_CHARS = 32_768;
const CONCERN_MAX_CHARS = 500;
const NOTIFY_REASON_MAX_CHARS = 1_000;
/** 読む変更履歴のファイルの上限。超えるものは読まずに未確認にする。 */
const CHANGELOG_FILE_MAX_BYTES = 4 * 1024 * 1024;
const PACKAGE_JSON_MAX_BYTES = 1024 * 1024;

// ---- 作業ツリー ----

/**
 * dependabotの作業項目の作業ツリーのパスを返す。`sha7`は固定したheadのshaの先頭7文字。
 * メインのclone(`ensureRepo`の`<owner>/<repo>/main`)の隣に置く。片付け(`cleanup_workspaces`)も、この関数でパスを求める。
 * `repoDir`が`/main`で終わらないときは例外を投げる。メインのcloneの外に作業ツリーを作らないため。
 */
export function buildDependabotWorktreeDir(
  repoDir: string,
  prNumber: number,
  sha7: string,
): string {
  if (!repoDir.endsWith("/main")) {
    throw new Error(`not a main clone directory: ${repoDir}`);
  }
  return `${dirname(repoDir)}/dependabot-${String(prNumber)}-${sha7}`;
}

export type RecreateWorktreeOps = {
  readonly listWorktrees: () => Promise<readonly WorktreeEntry[]>;
  readonly removeWorktree: (dir: string) => Promise<void>;
  readonly addDetachedWorktree: (sha: string, dir: string) => Promise<void>;
  /** 作った作業ツリーの`.git`を1回だけ読んで検証し、中身を返す。 */
  readonly readGitPointer: (dir: string) => Promise<string>;
};

/**
 * `dir`に`headSha`のdetachedの作業ツリーを作り、検証した`.git`の中身を返す。
 * 同じパスに作業ツリーがあれば、使い回さずに消してから作る。
 * 前の実行が残した`node_modules`や生成物を、影響調査が見ないようにするため。
 * 作業ツリーはheadのshaそのものから作り、ブランチなどほかのrefを辿らない。
 */
export async function recreateDependabotWorktree(
  ops: RecreateWorktreeOps,
  args: { readonly dir: string; readonly headSha: string },
): Promise<string> {
  const existing = await ops.listWorktrees();
  if (existing.some((entry) => entry.path === args.dir)) {
    await ops.removeWorktree(args.dir);
  }
  await ops.addDetachedWorktree(args.headSha, args.dir);
  return ops.readGitPointer(args.dir);
}

// ---- インストール ----

/**
 * インストールのコマンド。ルートとconsole/の両方を、ロックファイルを変えずに、ライフサイクルのスクリプトを実行せずに入れる。
 * `runAllowedCheckCommands`は空白で区切ってargvにするので、console/は`--cwd=`で指定する。
 */
export const DEPENDABOT_INSTALL_COMMANDS: readonly string[] = Object.freeze([
  "bun install --frozen-lockfile --ignore-scripts",
  "bun install --frozen-lockfile --ignore-scripts --cwd=console",
]);

export type InstallDeps = {
  readonly run: CommandRunner;
  readonly sandbox: CheckSandbox;
  readonly runChecks?: typeof runAllowedCheckCommands;
};

/**
 * 作業ツリーで`DEPENDABOT_INSTALL_COMMANDS`を、検査コマンドと同じ隔離(`runAllowedCheckCommands`)で実行する。
 * 非特権のuidに落とし、許可した環境変数と新しい非公開のHOMEで動かすので、パッケージのキャッシュは作業ツリーの外に置かれる。
 * 隔離を外す引数は持たない。workerが前提を満たさなければ`CheckEnvironmentError`を投げる。
 * 1回のインストールは`DEPENDABOT_INSTALL_TIMEOUT_MS`で打ち切る。
 */
export function runDependabotInstall(
  worktreeDir: string,
  deps: InstallDeps,
): Promise<readonly CheckCommandResult[]> {
  const runChecks = deps.runChecks ?? runAllowedCheckCommands;
  return runChecks(
    deps.run,
    worktreeDir,
    DEPENDABOT_INSTALL_COMMANDS,
    DEPENDABOT_INSTALL_TIMEOUT_MS,
    undefined,
    undefined,
    deps.sandbox,
  );
}

// ---- 作業ツリーのファイルの読み取り ----

/** インストールしたパッケージを読むファイル操作。テストでは偽物に差し替える。 */
export type InstalledFs = {
  readonly realpath: (path: string) => Promise<string>;
  readonly readDir: (path: string) => Promise<string[]>;
  /** `maxBytes`を超えるファイルは読まずに`null`を返す。 */
  readonly readTextLimited: (
    path: string,
    maxBytes: number,
  ) => Promise<string | null>;
  /** シンボリックリンクを辿らずに、その名前の項目があるかを返す。 */
  readonly entryExists: (path: string) => Promise<boolean>;
};

export const defaultInstalledFs: InstalledFs = {
  realpath: (path) => realpath(path),
  readDir: (path) => readdir(path),
  readTextLimited: async (path, maxBytes) => {
    const info = await stat(path);
    if (!info.isFile() || info.size > maxBytes) return null;
    return readFile(path, "utf8");
  },
  entryExists: async (path) => {
    try {
      await lstat(path);
      return true;
    } catch {
      return false;
    }
  },
};

/** `child`が`root`の下にあるか。同じパスは下と見なさない。 */
function isInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * `<worktreeDir>/<packageDir>`の実体のパスを返す。作業ツリーの外に解決されるとき、無いときは`null`。
 * `node_modules`の項目はシンボリックリンクでありうるので、実体が作業ツリーの中にあるときだけ読む。
 */
async function packageRoot(
  fs: InstalledFs,
  worktreeDir: string,
  packageDir: string,
): Promise<{ root: string; dir: string } | null> {
  try {
    const root = await fs.realpath(worktreeDir);
    const dir = await fs.realpath(join(worktreeDir, packageDir));
    return isInside(root, dir) ? { root, dir } : null;
  } catch {
    return null;
  }
}

/**
 * インストールしたパッケージの`package.json`を読み、`binding.gyp`の有無を調べる。
 * パッケージの実体が作業ツリーの外にあるとき、`package.json`の実体がパッケージの外にあるとき、
 * 読めないとき、通常のファイルでないとき、JSONでないとき、大きすぎるときは`null`を返す。
 * `binding.gyp`はシンボリックリンクを辿らずに見るので、リンク切れでも「ある」とする。
 * 呼び出し側は`null`を人に回す理由にする。
 */
export async function readInstalledPackageFrom(
  fs: InstalledFs,
  worktreeDir: string,
  packageDir: string,
): Promise<InstalledPackage | null> {
  const located = await packageRoot(fs, worktreeDir, packageDir);
  if (located === null) return null;
  let text: string | null;
  try {
    // package.json自体もシンボリックリンクでありうるので、実体がパッケージの中にあるときだけ読む。
    const path = await fs.realpath(join(located.dir, "package.json"));
    if (!isInside(located.dir, path)) return null;
    text = await fs.readTextLimited(path, PACKAGE_JSON_MAX_BYTES);
  } catch {
    return null;
  }
  if (text === null) return null;
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(text);
  } catch {
    return null;
  }
  return {
    packageJson,
    hasBindingGyp: await fs.entryExists(join(located.dir, "binding.gyp")),
  };
}

const CHANGELOG_FILE = /^(changelog|history|changes)(\.[A-Za-z0-9]+)?$/i;
const CHANGELOG_RANK: Readonly<Record<string, number>> = {
  changelog: 0,
  history: 1,
  changes: 2,
};

/**
 * インストールしたパッケージに同梱された変更履歴(`CHANGELOG*`、`HISTORY*`、`CHANGES*`)を読む。
 * 複数あれば、CHANGELOG、HISTORY、CHANGESの順に、同じ種類では名前の順に選ぶ。
 * 無いとき、実体がパッケージの外に解決されるとき、読めないとき、`CHANGELOG_FILE_MAX_BYTES`を超えるときは`null`を返す。
 */
export async function readChangelogFrom(
  fs: InstalledFs,
  worktreeDir: string,
  packageDir: string,
): Promise<string | null> {
  const located = await packageRoot(fs, worktreeDir, packageDir);
  if (located === null) return null;
  let names: string[];
  try {
    names = await fs.readDir(located.dir);
  } catch {
    return null;
  }
  const candidates = names
    .map((name) => ({ name, match: CHANGELOG_FILE.exec(name) }))
    .flatMap(({ name, match }) =>
      match === null
        ? []
        : [{ name, rank: CHANGELOG_RANK[(match[1] ?? "").toLowerCase()] ?? 3 }],
    )
    .sort((a, b) => a.rank - b.rank || (a.name < b.name ? -1 : 1));
  const chosen = candidates[0];
  if (chosen === undefined) return null;
  try {
    const path = await fs.realpath(join(located.dir, chosen.name));
    if (!isInside(located.dir, path)) return null;
    return await fs.readTextLimited(path, CHANGELOG_FILE_MAX_BYTES);
  } catch {
    return null;
  }
}

// ---- 成果物の要約 ----

/** マニフェストが変わらなかったときに、`manifestDiff`へ入れる文。 */
const NO_MANIFEST_CHANGED = "(no manifest changed)";

/**
 * 影響調査に渡す、変わった依存の指定の要約を返す。
 * マニフェストが1つも変わらなかったとき(推移的な依存だけの更新)は、その旨の文にして確認済みとする。
 * マニフェストが変わったのに要約が空のとき(読めないマニフェストなど)は、未確認にする。
 */
export function manifestDiffFor(files: GateInput["files"]): {
  text: string;
  verified: boolean;
} {
  const manifests = files.filter(
    (file) =>
      file.path === "package.json" || file.path.endsWith("/package.json"),
  );
  if (manifests.length === 0)
    return { text: NO_MANIFEST_CHANGED, verified: true };
  const text = buildManifestDiffSummary(files);
  return { text, verified: text !== "" };
}

const LOCKFILE_NAME = "bun.lock";

/**
 * 変わったロックファイルから、インストールした対象のディレクトリ(作業ツリーからの相対パス)を求める。
 * ロックファイルは`LOCKFILE_PATHS`のどれかで、同じディレクトリの`node_modules/<name>`に写す。
 * ロックファイルが1つも変わっていないとき、写せないロックファイルが変わっているときは`problem`に理由を入れる。
 * 呼び出し側は`problem`を人に回す理由にする。突き合わせを黙って飛ばさないため。
 */
export function installedPackageDirsFor(
  changedPaths: readonly string[],
  name: string,
): { dirs: string[]; problem: string | null } {
  const dirs: string[] = [];
  for (const path of changedPaths) {
    if (path !== LOCKFILE_NAME && !path.endsWith(`/${LOCKFILE_NAME}`)) continue;
    if (!LOCKFILE_PATHS.includes(path)) {
      return { dirs: [], problem: `changed lockfile is not mapped: ${path}` };
    }
    const prefix = path.slice(0, path.length - LOCKFILE_NAME.length);
    dirs.push(`${prefix}node_modules/${name}`);
  }
  return dirs.length === 0
    ? { dirs, problem: "no changed lockfile to inspect the install" }
    : { dirs, problem: null };
}

const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;
// npmのパッケージ名の形。作業ツリーの中のパスに使うので、`..`と区切りの乱用を通さない。
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

/** 対象の名前と版が、パスとプロンプトに使える形かを返す。 */
function isUsableTarget(name: string, from: string, to: string): boolean {
  return (
    PACKAGE_NAME.test(name) &&
    !name.includes("..") &&
    PLAIN_VERSION.test(from) &&
    PLAIN_VERSION.test(to)
  );
}

// ---- 本体 ----

/** ゲートを通した対象1つと、その対象について集めた事実。 */
type Member = {
  readonly name: string;
  readonly from: string;
  readonly to: string;
  readonly facts: GateTargetFacts;
  readonly pkg: CollectedPackage;
};

/**
 * dependabotの作業項目の準備をする。手順は次のとおり。
 * 1. 作業項目が`picked`の`dependabot`でなければ、何もせずに終える。
 * 2. `dependabot_enabled`が偽なら、取り消す(`dependabot_disabled`)。
 * 3. 事実を集め直す。閉じたPRは取り消し(`pr_closed`)、待ちは取り消し(`gate_waiting`)、
 *    人に回す結果と、GitHubの403は人に回す。そのほかの例外はそのまま投げる。
 * 4. 集めたheadが作業項目のheadと違えば、取り消す(`head_moved`)。
 * 5. ゲート(`evaluateGateGroup`)を全対象について評価する。待ちは取り消し(`gate_waiting`)、止める結果は人に回す。
 *    対象と集めた事実の並びが合わないとき、対象の名前か版がパスやプロンプトに使えない形のときも人に回す。
 * 6. cloneの前に、リポジトリのオーナーの数値IDを照合する。通らなければ、取得せずに人に回す。取得の失敗(404以外)は例外を投げる。
 * 7. headのshaの作業ツリーを作り直し、隔離した環境でインストールする。失敗は人に回す。
 * 8. `.git`を確かめてから`git status`を実行し、終了コードと出力を確かめる。きれいでなければ人に回す。
 * 9. 全対象について、インストールしたpackage.jsonのname、version、スクリプト、binding.gypを、registryの値と突き合わせる。
 *    食い違えば人に回す。複数の対象のときは、理由の先頭にパッケージの名前を付ける。
 * 10. 全対象について、repositoryのURLの前後を比べる。同じと確かめられなければ、機械の懸念に残して進む。
 * 11. 変更履歴、要約、PRのタイトルと本文を無害化して、影響調査の入力を組み立てる。
 *     変更履歴の抜粋や無害化と、要約が切り詰められたときは、その入力を未確認にする。
 *     入力の合計が`MAX_PROMPT_CHARS`を超えるときは、人に回す。
 * 取り消すときと人に回すときは、作業ツリーがあれば先に消してから状態を変える。
 * 人に回したときだけ通知し、通知には理由の訳を無害化して載せ、次の操作に再実行を案内しない。
 * 状態がほかの処理で動いていたときは、通知しない。
 */
export async function runDependabotPrepare(
  deps: DependabotPrepareDeps,
  input: DependabotPrepareInput,
): Promise<DependabotPrepareResult> {
  const { workItem } = input;
  const notReady = (reason: string): DependabotPrepareStopped => ({
    proceed: false,
    terminalStatus: null,
    reason,
    workItemId: workItem.id,
    assess: null,
  });
  if (workItem.kind !== "dependabot" || workItem.status !== "picked") {
    return notReady(
      `work item kind/status is "${workItem.kind}"/"${workItem.status}", not "dependabot"/"picked"`,
    );
  }
  const prNumber = workItem.pr_number;
  if (prNumber === null) {
    throw new Error(
      `dependabot_prepare: work item ${String(workItem.id)} has no pr_number`,
    );
  }
  if (!isCommitSha(workItem.head_sha)) {
    throw new Error(
      `dependabot_prepare: work item ${String(workItem.id)} has no full head sha`,
    );
  }
  const expectedHead = workItem.head_sha;

  let worktree: PreparedWorktree | null = null;
  const finish = async (
    to: "cancelled" | "needs_human",
    note: string,
  ): Promise<DependabotPrepareStopped> => {
    if (worktree !== null) {
      try {
        await deps.removeWorktree(worktree);
      } catch (error) {
        // 消せなかった作業ツリーは片付け(`cleanup_workspaces`)が消す。状態の記録は止めない。
        deps.warn("failed to remove the dependabot worktree", {
          work_item_id: workItem.id,
          error: maskSecrets(
            error instanceof Error ? error.message : String(error),
          ),
        });
      }
    }
    const moved = await deps.updateStatus(workItem.id, "picked", to, note);
    if (moved && to === "needs_human") {
      await deps.notify({
        kind: "needs_human",
        instance_name: input.instanceName,
        owner: workItem.owner,
        repo: workItem.repo,
        url: `https://github.com/${workItem.owner}/${workItem.repo}/pull/${String(prNumber)}`,
        reason: sanitizeUntrustedProse(
          describeReason(note),
          NOTIFY_REASON_MAX_CHARS,
        ),
        target: { kind: "pr", number: prNumber },
        next_action: nextActionFor(note, "dependabot"),
      });
    }
    return {
      proceed: false,
      terminalStatus: moved ? to : null,
      reason: note,
      workItemId: workItem.id,
      assess: null,
    };
  };

  if (!input.dependabotEnabled) {
    return finish("cancelled", DEPENDABOT_CANCEL_NOTE.disabled);
  }

  let collected: CollectOutcome;
  try {
    collected = await deps.collect();
  } catch (error) {
    // 403は権限かrulesetの問題で、待っても直らない。次の確認の時刻を持つ場所が無いので、人に回す。
    if (error instanceof GitHubHttpError && error.status === 403) {
      return finish(
        "needs_human",
        dependabotReason("collect", "GitHub refused the request (403)"),
      );
    }
    throw error;
  }
  const { result } = collected;
  if (result.kind === "closed") {
    return finish("cancelled", DEPENDABOT_CANCEL_NOTE.prClosed);
  }
  if (result.kind === "wait") {
    return finish("cancelled", DEPENDABOT_CANCEL_NOTE.gateWaiting);
  }
  if (result.kind === "needs_human") {
    return finish("needs_human", dependabotReason("collect", result.reason));
  }
  if (result.headSha !== expectedHead) {
    return finish("cancelled", DEPENDABOT_CANCEL_NOTE.headMoved);
  }
  const gate = evaluateGateGroup(
    result.common,
    result.targets,
    input.groupEnabled,
  );
  if (!gate.ok) {
    return gate.kind === "wait"
      ? finish("cancelled", DEPENDABOT_CANCEL_NOTE.gateWaiting)
      : finish("needs_human", dependabotReason("gate", gate.reason));
  }

  // 他のリポジトリのコマンドをworkerで動かさない。clone、インストール、オーナーの照合より前に止める。
  if (input.repoPolicy !== "primary") {
    return finish(
      "needs_human",
      dependabotReason("prepare", OTHER_REPO_UNSUPPORTED_REASON),
    );
  }

  // ゲートが評価した対象と、影響調査に渡す事実は、同じ順で同じパッケージを指さなければならない。
  const members: Member[] = [];
  for (const [index, facts] of result.targets.entries()) {
    const pkg = result.packages[index];
    if (pkg === undefined || pkg.name !== facts.target.name) {
      return finish(
        "needs_human",
        dependabotReason(
          "localCheck",
          "the collected packages do not match the targets",
        ),
      );
    }
    members.push({
      name: facts.target.name,
      from: pkg.from,
      to: facts.target.to,
      facts,
      pkg,
    });
  }
  if (result.packages.length !== members.length) {
    return finish(
      "needs_human",
      dependabotReason(
        "localCheck",
        "the collected packages do not match the targets",
      ),
    );
  }
  const isGroup = members.length > 1;
  /** 複数のパッケージを調べるとき、どのパッケージの理由かを名前で示す。名前は`isUsableTarget`を通した後に使う。 */
  const labeled = (name: string, reason: string): string =>
    isGroup ? `package ${name}: ${reason}` : reason;
  for (const [index, member] of members.entries()) {
    if (!isUsableTarget(member.name, member.from, member.to)) {
      return finish(
        "needs_human",
        dependabotReason(
          "localCheck",
          isGroup
            ? `target ${String(index + 1)} of ${String(members.length)} has an unexpected name or version form`
            : "the target name or version has an unexpected form",
        ),
      );
    }
  }

  // 取得の入口の照合から収集を挟むので、名前でcloneする直前にもう一度照合する。
  const ownerStop = await deps.ensureRepoOwner(workItem.owner, workItem.repo);
  if (ownerStop !== null) {
    return finish("needs_human", dependabotReason("prepare", ownerStop));
  }

  worktree = await deps.createWorktree(result.headSha);
  const worktreeDir = worktree.worktreeDir;

  let installed: readonly CheckCommandResult[];
  try {
    installed = await deps.runInstall(worktreeDir);
  } catch (error) {
    if (!(error instanceof CheckEnvironmentError)) throw error;
    await deps.reportCheckEnvironment(error);
    return finish(
      "needs_human",
      dependabotReason("installFailed", error.message),
    );
  }
  const failed = installed.find((command) => !command.ok);
  if (failed !== undefined) {
    return finish(
      "needs_human",
      dependabotReason(
        "installFailed",
        `${failed.command} ${failed.timedOut ? "timed out" : `exited with ${String(failed.exitCode)}`}`,
      ),
    );
  }

  // インストールが`.git`を書き換えていれば、その参照先の設定をrootのgitに読ませない。
  try {
    await deps.assertGitPointer(worktreeDir, worktree.gitPointer);
  } catch (error) {
    if (!(error instanceof WorktreeGitPointerModifiedError)) throw error;
    return finish(
      "needs_human",
      dependabotReason(
        "localCheck",
        "the worktree .git changed during the install",
      ),
    );
  }
  const status = await deps.run(buildGitArgv([...POST_INSTALL_STATUS_ARGV]), {
    cwd: worktreeDir,
    env: localGitEnv(),
  });
  // 失敗した実行の空の出力は「変更が無い」と読めてしまうので、出力を読む前に止める。
  if (
    status.exitCode !== 0 ||
    status.timedOut ||
    status.outputAbandoned === true
  ) {
    return finish(
      "needs_human",
      dependabotReason(
        "localCheck",
        `git status failed (exit ${String(status.exitCode)}${status.timedOut ? ", timed out" : ""}${status.outputAbandoned === true ? ", output abandoned" : ""})`,
      ),
    );
  }
  const clean = evaluatePostInstallStatus(status.stdout);
  if (!clean.ok) {
    return finish("needs_human", dependabotReason("localCheck", clean.reason));
  }

  const dirsByMember: (readonly string[])[] = [];
  for (const member of members) {
    const mapped = installedPackageDirsFor(
      result.common.changedPaths,
      member.name,
    );
    if (mapped.problem !== null) {
      return finish(
        "needs_human",
        dependabotReason("localCheck", labeled(member.name, mapped.problem)),
      );
    }
    dirsByMember.push(mapped.dirs);
    for (const packageDir of mapped.dirs) {
      const pkg = await deps.readInstalledPackage(worktreeDir, packageDir);
      if (pkg === null) {
        return finish(
          "needs_human",
          dependabotReason(
            "localCheck",
            labeled(
              member.name,
              `installed package could not be read: ${packageDir}`,
            ),
          ),
        );
      }
      const identity = installedIdentity(pkg.packageJson);
      if (
        identity === null ||
        identity.name !== member.name ||
        identity.version !== member.to
      ) {
        return finish(
          "needs_human",
          dependabotReason(
            "localCheck",
            labeled(
              member.name,
              `installed package is not the target: ${packageDir}`,
            ),
          ),
        );
      }
      const scripts = compareInstalledScripts(
        pkg.packageJson,
        pkg.hasBindingGyp,
        member.facts.installScripts.after,
      );
      if (!scripts.ok) {
        return finish(
          "needs_human",
          dependabotReason("localCheck", labeled(member.name, scripts.reason)),
        );
      }
    }
  }

  const machineConcerns: string[] = [];
  for (const member of members) {
    const repository = compareRepositoryUrls(
      member.pkg.repositoryBefore,
      member.pkg.repositoryAfter,
    );
    if (!repository.ok) {
      const concern = sanitizeUntrustedProse(
        repository.reason,
        CONCERN_MAX_CHARS,
      );
      // 名前は検証済みなので、無害化の外に置く。無害化は`@`を変え、名前の一致を崩す。
      machineConcerns.push(labeled(member.name, concern));
    }
  }

  const unverified: UnverifiedInputName[] = members.flatMap(
    (member) => member.pkg.unverifiedInputs,
  );
  const promptPackages: DependabotPromptPackage[] = [];
  for (const [index, member] of members.entries()) {
    const firstPackageDir = dirsByMember[index]?.[0];
    const rawChangelog =
      firstPackageDir === undefined
        ? null
        : await deps.readChangelog(worktreeDir, firstPackageDir);
    const excerpt =
      rawChangelog === null
        ? null
        : excerptChangelog(rawChangelog, member.from, member.to);
    const changelog =
      excerpt === null
        ? ""
        : sanitizeUntrustedProse(excerpt.text, CHANGELOG_MAX_CHARS);
    // 更新先の版の見出しが無い変更履歴は、その版の変更を確かめられないので未確認にする(本文はClaudeに渡す)。
    // 抜粋や無害化が区間を削ったときも未確認にする。削られた部分に破壊的な変更が含まれうるため。
    if (
      changelog === "" ||
      rawChangelog === null ||
      excerpt === null ||
      excerpt.truncated ||
      hasTruncationMark(changelog) ||
      !changelogCoversVersion(rawChangelog, member.to)
    ) {
      unverified.push("changelog");
    }
    promptPackages.push({
      name: member.name,
      from: member.from,
      to: member.to,
      changelog,
      registryMetadata: sanitizeUntrustedProse(
        member.pkg.registryMetadata,
        MAX_METADATA_CHARS,
      ),
    });
  }

  const manifest = manifestDiffFor(result.common.files);
  const manifestDiff = manifest.verified
    ? sanitizeUntrustedProse(manifest.text, MAX_SUMMARY_CHARS)
    : "";
  if (manifestDiff === "" || hasTruncationMark(manifestDiff)) {
    unverified.push("manifest diff");
  }
  const lockfileSummary = sanitizeUntrustedProse(
    buildLockfileSummary(result.common.files),
    MAX_SUMMARY_CHARS,
  );
  if (lockfileSummary === "" || hasTruncationMark(lockfileSummary)) {
    unverified.push("lockfile summary");
  }

  const pr = collected.pr;
  const prBody =
    pr === null ? "" : sanitizeUntrustedProse(pr.body, PR_BODY_MAX_CHARS);
  if (prBody === "") unverified.push("pull request body");

  const draft: DependabotPromptInput = {
    packages: promptPackages,
    prTitle:
      pr === null ? "" : sanitizeUntrustedProse(pr.title, PR_TITLE_MAX_CHARS),
    prBody,
    manifestDiff,
    lockfileSummary,
    unverifiedInputs: unverified,
  };
  const promptInput: DependabotPromptInput = {
    ...draft,
    unverifiedInputs: effectiveUnverifiedInputs(draft),
  };
  const size = checkPromptSize(promptInput);
  if (!size.ok) {
    return finish("needs_human", dependabotReason("localCheck", size.reason));
  }

  return {
    proceed: true,
    terminalStatus: null,
    reason: null,
    workItemId: workItem.id,
    assess: {
      workItemId: workItem.id,
      owner: workItem.owner,
      repo: workItem.repo,
      prNumber,
      headSha: result.headSha,
      baseRef: result.baseRef,
      baseSha: result.baseSha,
      mergeBaseSha: result.mergeBaseSha,
      repoDir: worktree.repoDir,
      worktreeDir,
      targets: members.map(({ name, from, to }) => ({ name, from, to })),
      promptInput,
      machineConcerns,
    },
  };
}

/** インストールしたpackage.jsonのnameとversion。どちらかが文字列でなければ`null`。 */
function installedIdentity(
  packageJson: unknown,
): { name: string; version: string } | null {
  if (
    typeof packageJson !== "object" ||
    packageJson === null ||
    Array.isArray(packageJson)
  ) {
    return null;
  }
  const name: unknown = Reflect.get(packageJson, "name");
  const version: unknown = Reflect.get(packageJson, "version");
  return typeof name === "string" && typeof version === "string"
    ? { name, version }
    : null;
}

// ---- 結線 ----

/**
 * 収集の依存を作る。registryの取得には、素のグローバル`fetch`をそのまま渡す。
 * 取得の側が`redirect: "manual"`と締め切りの`signal`を付けるので、包むとそれが外れうるため。
 * `build`はテストで差し替える。
 */
export function collectDepsFor(
  args: {
    readonly client: GhClient;
    readonly config: Pick<
      FactoryConfig,
      | "dependabot_min_published_days"
      | "dependabot_group_enabled"
      | "dependabot_other_repos"
      | "factory_repo"
    >;
    readonly now: () => number;
  },
  build: typeof buildCollectDeps = buildCollectDeps,
): CollectDeps {
  return build({
    client: args.client,
    config: args.config,
    fetchImpl: fetch,
    now: args.now,
  });
}

/**
 * `deps.getPr`を包み、最後に読んだPRを覚える。
 * 収集は最後にPRを読み直して動いていないことを確かめるので、`ready`のときに覚えたPRは、事実を固定したheadのものである。
 */
export function withPrCapture(deps: CollectDeps): {
  deps: CollectDeps;
  lastPr: () => PullRequest | null;
} {
  let last: PullRequest | null = null;
  return {
    deps: {
      ...deps,
      getPr: async (owner, repo, number) => {
        const pr = await deps.getPr(owner, repo, number);
        last = pr;
        return pr;
      },
    },
    lastPr: () => last,
  };
}

/**
 * dependabotの作業項目の準備をする(`runDependabotPrepare`)。
 * 作業項目が無いとき、PR番号か完全なheadのshaが無いときは例外を投げる。
 */
export async function main(
  work_item_id: number,
): Promise<DependabotPrepareResult> {
  const workItem = await getWorkItem(work_item_id);
  if (workItem === null) {
    throw new Error(`dependabot_prepare: no work item with id ${work_item_id}`);
  }
  assertGitHubName(workItem.owner);
  assertGitHubName(workItem.repo);
  const log = logger("dependabot_prepare");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  const prNumber = workItem.pr_number;

  const ghToken = await wmill.getVariable("f/factory/github_token");
  const client: GhClient = { run: runCommand, ghToken };
  const owner = workItem.owner;
  const repo = workItem.repo;

  return runDependabotPrepare(
    {
      collect: async () => {
        if (prNumber === null) throw new Error("work item has no pr_number");
        const capture = withPrCapture(
          collectDepsFor({ client, config, now: () => Date.now() }),
        );
        const result = await collectGateInput(capture.deps, {
          owner,
          repo,
          number: prNumber,
        });
        return { result, pr: capture.lastPr() };
      },
      ensureRepoOwner: (ownerName, repoName) =>
        repoOwnerStopReason(
          config,
          ownerName,
          repoName,
          repoOwnerGateDeps(client, addNoticeUnlessUnresolved),
        ),
      createWorktree: async (headSha) => {
        if (prNumber === null) throw new Error("work item has no pr_number");
        const { dir: repoDir } = await ensureRepo({
          run: runCommand,
          owner,
          repo,
          ghToken,
        });
        await fetchPrHeadRef(runCommand, repoDir, prNumber, ghToken);
        const dir = buildDependabotWorktreeDir(
          repoDir,
          prNumber,
          headSha.slice(0, 7),
        );
        const gitPointer = await recreateDependabotWorktree(
          {
            listWorktrees: () => listWorktrees({ run: runCommand, repoDir }),
            removeWorktree: (target) =>
              removeWorktree({
                run: runCommand,
                repoDir,
                dir: target,
                force: true,
              }),
            addDetachedWorktree: async (sha, target) => {
              await addDetachedWorktree({
                run: runCommand,
                repoDir,
                sha,
                dir: target,
                ghToken,
              });
            },
            readGitPointer: (target) =>
              readAndVerifyWorktreeGitPointer({
                run: runCommand,
                repoDir,
                dir: target,
              }),
          },
          { dir, headSha },
        );
        return { repoDir, worktreeDir: dir, gitPointer };
      },
      removeWorktree: (target) =>
        removeWorktree({
          run: runCommand,
          repoDir: target.repoDir,
          dir: target.worktreeDir,
          force: true,
        }),
      runInstall: (worktreeDir) =>
        runDependabotInstall(worktreeDir, {
          run: runCommand,
          // 枠を片付けられずに飛ばしたときなどは、インストールを止めずにnoticeで知らせる。
          sandbox: checkSandboxFromEnv(process.env, async (notice) => {
            await addNoticeUnlessUnresolved(notice);
          }),
        }),
      reportCheckEnvironment: (error) =>
        recordCheckEnvironmentNotice(
          {
            readDeployedSha: () => wmill.getVariable("f/factory/deployed_sha"),
            addNotice: addNoticeUnlessUnresolved,
            log,
          },
          error,
        ),
      assertGitPointer: (worktreeDir, expected) =>
        assertWorktreeGitPointer(worktreeDir, expected),
      run: runCommand,
      readInstalledPackage: (worktreeDir, packageDir) =>
        readInstalledPackageFrom(defaultInstalledFs, worktreeDir, packageDir),
      readChangelog: (worktreeDir, packageDir) =>
        readChangelogFrom(defaultInstalledFs, worktreeDir, packageDir),
      updateStatus: (id, from, to, note) =>
        updateStatusIfCurrent(id, from, to, note),
      notify: async (event) => {
        // 通知は状態を記録した後に送るので、webhookを読めなくてもステップを失敗させない。
        try {
          await notifyBestEffort(
            await wmill.getVariable("f/factory/discord_webhook_url"),
            event,
            log,
          );
        } catch (error) {
          log.warn("failed to read the discord webhook url", {
            error: maskSecrets(
              error instanceof Error ? error.message : String(error),
            ),
          });
        }
      },
      warn: (message, fields) => log.warn(message, fields),
    },
    {
      workItem,
      dependabotEnabled: config.dependabot_enabled,
      groupEnabled: config.dependabot_group_enabled,
      repoPolicy: resolveRepoPolicy(config, owner, repo),
      instanceName: config.instance_name,
    },
  );
}
