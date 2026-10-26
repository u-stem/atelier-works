// 2分ごとに、Factory自身のself clone(`/workspaces/factory/atelier-works`)を
// pullする。前回記録したデプロイからHEADが進んでいれば、worker自身の中から
// Windmillの定義をpushし、未適用のData Tableのmigrationを適用する。
//
// 判断と整形の純粋なロジック(再デプロイが要るか、どの変更パスがworkerの中から
// は反映できずホスト側の次回起動で反映されるか、`wmill` CLIの子プロセスに渡す
// 最小のenv)は`./lib/self_update_support.ts`にあり、このファイルは入出力を
// つなぐだけ。`infra/`と`mise.toml`の変更はworkerの中からは反映できず、
// 人が`mise run up`するまで効かないため、`deployments`に記録したうえで
// 要対応の通知とDiscordで知らせる(`./lib/host_action.ts`)。
// ホストが`mise run up`の最後に書く印を毎回読み、反映が済んだ通知は解決する。
// 解決は、反映の判断と記録の後に行う(反映が不要な回でも行う)。解決が遅れても反映を遅らせないため。
//
// ジョブ全体の上限(`self_update.script.yaml`の`timeout`)は、`SELF_UPDATE_WORST_CASE_MS`以上にする。
// 内訳と、打ち切られた回の扱いは`docs/architecture.md`の「自己更新」にある。
// 上限の無い呼び出しは`withCallTimeout`で区切り、通常は内側の上限で先に終わらせる。
//
// `f/factory/deployed_sha`(秘密でないWindmillの変数)はsyncの対象から
// 完全に外している(`wmill.yaml`の`excludes`のコメントを参照)。
// `scripts/bootstrap.sh`が空の値で一度だけ作り、以降は下の
// `wmill.setVariable`だけが値を変える。無関係な`wmill sync push`で戻らない。
import wmillDefault, * as wmill from "windmill-client@1.817.0";
import { isRequirementsApprovedForAttempt } from "./lib/approval_gate.ts";
import { buildNoticeConsoleUrl } from "./lib/approval_support.ts";
import {
  AUTO_RETRY_LIST_LIMIT,
  autoRetryCandidateQuery,
  hasRetryableCandidate,
  shouldStartStaleImageRetry,
} from "./lib/auto_retry.ts";
import {
  DESIGN_ENABLED_IGNORED_NOTICE_KIND,
  loadConfig,
} from "./lib/config.ts";
import {
  CONSOLE_WORKER_CHECK_TIMEOUT_MS,
  consoleQueueQuery,
  watchConsoleWorker,
  watchRunsQuery,
} from "./lib/console_worker.ts";
import {
  addNoticeUnlessUnresolved,
  latestRequirementsApproval,
  listAutoRetryCandidates,
  listGhCollectFreshness,
  listGhRepoStaleSnapshot,
  listUnresolvedNoticesByKind,
  recordDeployment,
  recordFailure,
  resolveNoticeIfUnresolved,
  resolveUnresolvedNoticesByPrefix,
} from "./lib/db.ts";
import {
  DISCORD_RETRY_MAX_WAIT_MS,
  type FetchLike,
  notifyBestEffort,
} from "./lib/discord.ts";
import {
  ensureVerifiedFactoryClone,
  FactoryRepoIdMismatchError,
} from "./lib/factory_repo_gate.ts";
import {
  chooseFreezeAction,
  type FrozenPushPlan,
  finishFrozenPush,
  loadFreezeInputs,
  prepareFrozenPush,
  sdkFreezePorts,
  shouldHoldDeploy,
} from "./lib/freeze_apply.ts";
import type { Outcome } from "./lib/freezes.ts";
import {
  checkGhCollectFreshness,
  GH_COLLECT_FRESHNESS_CHECK_TIMEOUT_MS,
  GH_COLLECT_STALE_KIND,
} from "./lib/gh_collect_freshness.ts";
import {
  ghDetailStaleAfterMs,
  nonExplicitReposPossible,
  repoStaleTargetFilter,
  summarizeRepoStale,
} from "./lib/gh_collect_read.ts";
import { getRepositoryId } from "./lib/github.ts";
import {
  HOST_ACTION_NOTICE_KIND,
  HOST_ACTION_RECONCILE_LIMIT,
  HOST_ACTION_RESOLVER,
  hostAppliedChecker,
  readHostAppliedSha,
  reconcileHostActionNotices,
  recordHostAction,
} from "./lib/host_action.ts";
import { jobTmpEnv } from "./lib/job_tmp.ts";
import { type Logger, logger, maskSecrets } from "./lib/log.ts";
import {
  checkPeriodicWorker,
  PERIODIC_WORKER_CHECK_TIMEOUT_MS,
  periodicQueueQuery,
} from "./lib/periodic_worker.ts";
import {
  MERGED_PULL_REQUESTS_LOG_FORMAT,
  parseMergedPullRequests,
} from "./lib/self_update_pull_requests.ts";
import {
  assertBranchMatches,
  buildWmillArgv,
  buildWmillEnv,
  classifyChangedPaths,
  DESIGN_NOTICE_CHECK_TIMEOUT_MS,
  decideUpdate,
  deploymentFailureMessage,
  describeTriggerEnv,
  MISE_TOML_PATH,
  miseTomlNeedsHostAction,
  parseNulSeparatedPaths,
  readDeployedSha,
  reconcileDesignEnabledNotice,
  recordFailedDeployment,
  recordSuccessDeployment,
  resolveTriggerKind,
  resolveWmillCliContext,
  SELF_UPDATE_CALL_TIMEOUT_MS,
  setDeployedSha,
  truncateOutput,
  withCallTimeout,
} from "./lib/self_update_support.ts";
import { assertSha, type DeploymentPullRequest } from "./lib/types.ts";
import {
  assertOutputComplete,
  type CommandResult,
  type CommandRunner,
  DEFAULT_TIMEOUT_MS,
  FACTORY_CLONE_UPDATE_GIT_COMMAND_COUNT,
  omittedMarkerIndex,
  pathExists,
  REPO_LOCK_MAX_WAIT_MS,
  REPO_LOCK_POLL_MS,
  RUNNER_MAX_STOP_OVERHEAD_MS,
  runCommand,
} from "./lib/workspace.ts";

// ---------------------------------------------------------------------------
// self cloneのgit操作。判断を含まない単発のgitの入出力なので、
// libに出さずこのscriptに閉じる(`poll_issues.ts`の`readRepoHeadSha`と同じ)。
// ---------------------------------------------------------------------------

/**
 * ローカルのオブジェクトを参照するだけのgit(`cat-file`、`merge-base`)の上限(ミリ秒)。
 * ネットワークにもワークツリーにも触れないので、既定の上限より短くする。
 */
export const SELF_UPDATE_LOCAL_GIT_TIMEOUT_MS = 10_000;

const GIT_BASE_ARGV: readonly string[] = [
  "git",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "credential.helper=",
];

function selfCloneGitEnv(): Record<string, string> {
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
    ...jobTmpEnv(),
  };
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  return env;
}

/**
 * self cloneでチェックアウト中のコミットのshaを返す(`git rev-parse HEAD`)。
 * ローカルだけで完結し、`GH_TOKEN`は要らない。gitが失敗したら例外を投げる。
 */
export async function readSelfCloneHeadSha(
  run: CommandRunner,
  dir: string,
): Promise<string> {
  const result = await run([...GIT_BASE_ARGV, "rev-parse", "HEAD"], {
    cwd: dir,
    env: selfCloneGitEnv(),
  });
  if (result.exitCode !== 0) {
    throw new Error(
      maskSecrets(
        `git rev-parse HEAD failed in ${dir}: ${result.stderr.trim()}`,
      ),
    );
  }
  return result.stdout.trim();
}

/**
 * self cloneでチェックアウト中のブランチ名を返す
 * (`git rev-parse --abbrev-ref HEAD`)。ローカルだけで完結する。
 * `ensureFactoryClone`が本当に`config.factory_branch`に切り替えたかを
 * 重ねて確かめるために使う。実際のworkerでcloneが`main`に留まったことがある
 * (経緯は`lib/workspace.ts`のモジュールコメントを参照)。
 */
export async function readSelfCloneBranch(
  run: CommandRunner,
  dir: string,
): Promise<string> {
  const result = await run(
    [...GIT_BASE_ARGV, "rev-parse", "--abbrev-ref", "HEAD"],
    { cwd: dir, env: selfCloneGitEnv() },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      maskSecrets(
        `git rev-parse --abbrev-ref HEAD failed in ${dir}: ${result.stderr.trim()}`,
      ),
    );
  }
  return result.stdout.trim();
}

/**
 * self cloneの`newSha`にあるすべてのファイルパスを返す
 * (`git ls-tree -r --name-only -z`)。比べる前回デプロイのshaが無いとき、
 * 差分の代わりに使い、全ファイルを変更として扱う。
 * `-z`を付けるのは、非ASCIIのパスが引用符つきで出力されないようにするため。
 */
export async function listAllPaths(
  run: CommandRunner,
  dir: string,
  newSha: string,
): Promise<string[]> {
  assertSha(newSha);
  const result = await run(
    [...GIT_BASE_ARGV, "ls-tree", "-r", "--name-only", "-z", newSha],
    { cwd: dir, env: selfCloneGitEnv() },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      maskSecrets(`git ls-tree failed in ${dir}: ${result.stderr.trim()}`),
    );
  }
  return parseNulSeparatedPaths(result.stdout);
}

/**
 * self cloneの2つのコミットの間で変わったファイルパスを返す
 * (`git diff --name-only -z oldSha..newSha`)。
 * `-z`の理由は`listAllPaths`と同じ。`--no-renames`を付けるのは、
 * 改名の検出が有効だと新しい名前だけが列挙され、`infra/`から外へ
 * 移したファイルを変更として拾えないため(旧名と新名の両方を列挙させる)。
 * どちらのshaも`assertSha`で検査し、ここでは常に内部で得た16進のshaで
 * 外部の入力ではない。そのため`--`で区切らず直接埋め込んでも安全
 * (`lib/workspace.ts`のgit操作と同じ理由)。
 */
export async function diffPaths(
  run: CommandRunner,
  dir: string,
  oldSha: string,
  newSha: string,
): Promise<string[]> {
  assertSha(oldSha);
  assertSha(newSha);
  const result = await run(
    [
      ...GIT_BASE_ARGV,
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      `${oldSha}..${newSha}`,
    ],
    { cwd: dir, env: selfCloneGitEnv() },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      maskSecrets(`git diff failed in ${dir}: ${result.stderr.trim()}`),
    );
  }
  return parseNulSeparatedPaths(result.stdout);
}

/**
 * `git log`の出力の保持量の上限(バイト)。マージのコミットの本文は信頼できない文字列なので、
 * 長い期間の履歴や大きな本文でも、メモリに載せる量を決めておく。
 * 超えたときは先頭(新しい側)と末尾が残り、間が省かれる。
 */
export const MERGED_PULL_REQUESTS_LOG_MAX_BYTES = 4 * 1024 * 1024;

/**
 * `oldSha`から`newSha`の間でmainにマージされたPRを新しい順に返す。
 * 第1親だけをたどる(`--first-parent`)ので、PRのブランチの中のコミットは読まない。
 * `oldSha`が空(前回の反映が無い)ときは、履歴の全体を数えないよう、gitを呼ばずに空配列を返す。
 * 解析は`parseMergedPullRequests`が行う。gitが失敗したら例外を投げる。
 */
export async function listMergedPullRequests(
  run: CommandRunner,
  dir: string,
  oldSha: string,
  newSha: string,
  factoryRepoUrl: string,
): Promise<DeploymentPullRequest[]> {
  if (oldSha.length === 0) return [];
  assertSha(oldSha);
  assertSha(newSha);
  const result = await run(
    [
      ...GIT_BASE_ARGV,
      "log",
      "--first-parent",
      "-z",
      `--format=${MERGED_PULL_REQUESTS_LOG_FORMAT}`,
      `${oldSha}..${newSha}`,
    ],
    {
      cwd: dir,
      env: selfCloneGitEnv(),
      maxOutputBytes: MERGED_PULL_REQUESTS_LOG_MAX_BYTES,
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      maskSecrets(`git log failed in ${dir}: ${result.stderr.trim()}`),
    );
  }
  return parseMergedPullRequests(result.stdout, factoryRepoUrl);
}

/**
 * self cloneで`ancestor`が`descendant`の祖先か(同じコミットを含む)を返す
 * (`git merge-base --is-ancestor`)。終了コード0が祖先、1が祖先でない。
 * それ以外(未知のコミットなど)は確かめられないので例外を投げる。
 * どちらのshaも`assertSha`で検査する(理由は`diffPaths`と同じ)。
 */
export async function isAncestorSha(
  run: CommandRunner,
  dir: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  assertSha(ancestor);
  assertSha(descendant);
  const result = await run(
    [...GIT_BASE_ARGV, "merge-base", "--is-ancestor", ancestor, descendant],
    {
      cwd: dir,
      env: selfCloneGitEnv(),
      timeoutMs: SELF_UPDATE_LOCAL_GIT_TIMEOUT_MS,
    },
  );
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1 && !result.timedOut) return false;
  throw new Error(
    maskSecrets(
      `git merge-base --is-ancestor failed in ${dir}: ${result.stderr.trim()}`,
    ),
  );
}

/**
 * self cloneに`sha`のコミットがあるかを返す(`git cat-file -e <sha>^{commit}`)。
 * 無ければ`false`。時間切れのときは確かめられないので例外を投げる。
 */
export async function isCommitInClone(
  run: CommandRunner,
  dir: string,
  sha: string,
): Promise<boolean> {
  assertSha(sha);
  const result = await run(
    [...GIT_BASE_ARGV, "cat-file", "-e", `${sha}^{commit}`],
    {
      cwd: dir,
      env: selfCloneGitEnv(),
      timeoutMs: SELF_UPDATE_LOCAL_GIT_TIMEOUT_MS,
    },
  );
  if (result.timedOut) {
    throw new Error(`git cat-file timed out in ${dir}`);
  }
  return result.exitCode === 0;
}

/**
 * `listDifferingPaths`が保持する出力の上限(バイト)。超えるほど多くのパスが異なる版は、内容を比べずに未反映として扱う。
 * 全部を読めないまま比べると、読めなかったパスの違いを見落とすためである。
 */
export const HOST_CONTENT_DIFF_MAX_BYTES = 1024 * 1024;

/**
 * self cloneの`from`と`to`の間で内容が異なるパスを返す(`git diff --name-only --no-renames -z from to`)。
 * ホストの反映済みの版と内容を比べるために使う。改名を検出しないのは、旧名と新名の両方を列挙させるためである。
 * 失敗、時間切れ、出力の読み取りの打ち切り、出力が`HOST_CONTENT_DIFF_MAX_BYTES`を超えて間が省かれたときは、例外を投げる。
 * 省かれた印に見えるパスがあっても、比べるのを諦めるだけで、反映済みにはならない。
 */
export async function listDifferingPaths(
  run: CommandRunner,
  dir: string,
  from: string,
  to: string,
): Promise<string[]> {
  assertSha(from);
  assertSha(to);
  const result = await run(
    [...GIT_BASE_ARGV, "diff", "--name-only", "--no-renames", "-z", from, to],
    {
      cwd: dir,
      env: selfCloneGitEnv(),
      timeoutMs: SELF_UPDATE_LOCAL_GIT_TIMEOUT_MS,
      maxOutputBytes: HOST_CONTENT_DIFF_MAX_BYTES,
    },
  );
  if (result.timedOut) {
    throw new Error(`git diff timed out in ${dir}`);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      maskSecrets(`git diff failed in ${dir}: ${result.stderr.trim()}`),
    );
  }
  assertOutputComplete(`git diff in ${dir}`, result);
  if (omittedMarkerIndex(result.stdout) >= 0) {
    throw new Error(`too many differing paths between ${from} and ${to}`);
  }
  return parseNulSeparatedPaths(result.stdout);
}

/**
 * `<dir>/wmill.yaml`が無ければ例外を投げる。
 * 実際のworkerで、syncのルートでないディレクトリからCLIを実行し、
 * `wmill sync push`が"No wmill.yaml found."と表示しつつ"0 changes"で
 * 正常終了したことがある。何もしないpushが気づかれずに通らないよう、
 * 最初から拒否する。`exists`はテスト用に差し替えられる(既定は`pathExists`)。
 */
export async function assertWmillYamlExists(
  dir: string,
  exists: (path: string) => Promise<boolean> = pathExists,
): Promise<void> {
  const wmillYamlPath = `${dir}/wmill.yaml`;
  if (!(await exists(wmillYamlPath))) {
    throw new Error(
      `self_update: ${wmillYamlPath} not found — refusing to run the wmill CLI from an unexpected working directory`,
    );
  }
}

/**
 * self cloneの`sha`の時点の`path`の内容を返す(`git show <sha>:<path>`)。
 * そのコミットにファイルが無ければ`null`を返す。ローカルだけで完結する。
 */
export async function readFileAtSha(
  run: CommandRunner,
  dir: string,
  sha: string,
  path: string,
): Promise<string | null> {
  assertSha(sha);
  const result = await run([...GIT_BASE_ARGV, "show", `${sha}:${path}`], {
    cwd: dir,
    env: selfCloneGitEnv(),
  });
  return result.exitCode === 0 ? result.stdout : null;
}

/**
 * `oldSha`から`newSha`への`mise.toml`の変更が、ホストに関わる節に及ぶかを返す
 * (`miseTomlNeedsHostAction`を参照)。前回のデプロイが無い(`oldSha`が空)
 * ときは、安全側に倒して`true`になる。
 */
export async function miseTomlHostSectionsChanged(
  run: CommandRunner,
  dir: string,
  oldSha: string,
  newSha: string,
): Promise<boolean> {
  const newToml = await readFileAtSha(run, dir, newSha, MISE_TOML_PATH);
  if (newToml === null) return false;
  const oldToml =
    oldSha.length === 0
      ? null
      : await readFileAtSha(run, dir, oldSha, MISE_TOML_PATH);
  return miseTomlNeedsHostAction(oldToml, newToml);
}

async function resolveChangedPaths(
  run: CommandRunner,
  dir: string,
  oldSha: string,
  newSha: string,
): Promise<string[]> {
  return oldSha.length === 0
    ? listAllPaths(run, dir, newSha)
    : diffPaths(run, dir, oldSha, newSha);
}

type DeployedShaAdvance = {
  readonly changedPaths: string[];
  readonly classification: ReturnType<typeof classifyChangedPaths>;
};

/**
 * `deployed_sha`を更新し、そのあとで変更パスを列挙して分類する。
 * 更新を先に行うのは、`deployed_sha`が clone に無い値などの誤った値のとき、列挙が失敗し続けて
 * 同じ範囲のpushとmigrationと失敗の記録が2分ごとに繰り返されるのを、1回の失敗で`HEAD`に進めて止めるため。
 * 更新できたら`onUpdated`を呼ぶ。更新の後に列挙が失敗すると、host actionの通知と`changed_paths`が欠ける。
 */
export async function advanceDeployedSha(deps: {
  readonly setSha: () => Promise<void>;
  readonly onUpdated: () => void;
  readonly listChangedPaths: () => Promise<string[]>;
  readonly hostSectionsChanged: () => Promise<boolean>;
}): Promise<DeployedShaAdvance> {
  await deps.setSha();
  deps.onUpdated();
  const changedPaths = await deps.listChangedPaths();
  const miseChanged = changedPaths.includes(MISE_TOML_PATH)
    ? await deps.hostSectionsChanged()
    : false;
  const classification = classifyChangedPaths(changedPaths, miseChanged);
  return { changedPaths, classification };
}

// ---------------------------------------------------------------------------
// `wmill` CLIの子プロセスの実行
// ---------------------------------------------------------------------------

const WMILL_CLI_TIMEOUT_MS = 5 * 60_000;
const LOG_OUTPUT_MAX = 4000;

function logCommandOutput(
  log: Logger,
  step: string,
  result: CommandResult,
  secrets: readonly string[],
): void {
  log.info(step, {
    exit_code: result.exitCode,
    timed_out: result.timedOut,
    stdout: truncateOutput(maskSecrets(result.stdout, secrets), LOG_OUTPUT_MAX),
    stderr: truncateOutput(maskSecrets(result.stderr, secrets), LOG_OUTPUT_MAX),
  });
}

/**
 * `wmill` CLIを実行し、出力をログに残す。終了コードが0以外か、
 * タイムアウトしたら例外を投げる。
 * `secrets`は、ログと例外の文からwmillのAPIトークンを隠すために渡す。
 * トークンはargvにそのまま入る(`--token`の代わりになる環境変数が無いため。
 * `buildWmillArgv`のコメントを参照)ので、CLIのエラーが自分の起動引数を
 * 繰り返すと漏れる。WindmillのAPIトークンには`maskSecrets`が自動で
 * 見分けられる決まった形式が無いので、明示的に渡す必要がある。
 */
async function runWmillCli(
  argv: readonly string[],
  cwd: string,
  env: Record<string, string>,
  log: Logger,
  step: string,
  secrets: readonly string[],
): Promise<void> {
  const result = await runCommand(argv, {
    cwd,
    env,
    timeoutMs: WMILL_CLI_TIMEOUT_MS,
  });
  logCommandOutput(log, step, result, secrets);
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(
      maskSecrets(
        `${step} failed (exit ${String(result.exitCode)}, timed_out=${String(result.timedOut)}): ${result.stderr.trim()}`,
        secrets,
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// スケジュールの凍結
// ---------------------------------------------------------------------------

/**
 * 凍結の読む段と書く段それぞれの上限(ミリ秒)。段の中の呼び出し(変数の読み、有無の確認、書き込み)は
 * この1つの上限で包み、`SELF_UPDATE_BOUNDED_CALL_COUNT`には数えない。
 * 段の数を`SELF_UPDATE_FREEZE_PHASE_COUNT`として最悪の長さに足す。
 * 段の中は変数のAPIだけで、子プロセスを起動しない。
 */
export const FREEZE_PHASE_TIMEOUT_MS = 10_000;

/** 1回の実行で通る、凍結の段の数(読む段と書く段)。 */
export const SELF_UPDATE_FREEZE_PHASE_COUNT = 2;

/**
 * 凍結の変数を読み、`wmill sync push`へ渡す除外と追従の対象を作る。
 * 読めない、壊れている、時間切れのときは失敗として返す。呼び出し側は、反映が要る回では反映せず、
 * 反映が不要な回では警告だけで終える。
 */
async function prepareFreezePlan(
  cloneDir: string,
): Promise<Outcome<FrozenPushPlan>> {
  try {
    return await withCallTimeout(
      "freeze prepare",
      async () => {
        const inputs = await loadFreezeInputs(cloneDir);
        if (!inputs.ok) return inputs;
        return await prepareFrozenPush(
          sdkFreezePorts(wmill, wmillDefault.getWorkspace(), () => new Date()),
          inputs.value,
        );
      },
      FREEZE_PHASE_TIMEOUT_MS,
    );
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 追従のpushが済んだ行を消す。失敗しても反映は済んでいるので、警告だけ残して次の回に任せる。 */
async function finishFreezePlan(
  plan: FrozenPushPlan,
  log: Logger,
): Promise<void> {
  try {
    await withCallTimeout(
      "freeze finish",
      () =>
        finishFrozenPush(
          sdkFreezePorts(wmill, wmillDefault.getWorkspace(), () => new Date()),
          plan.readyIds,
        ),
      FREEZE_PHASE_TIMEOUT_MS,
    );
  } catch (err) {
    // 行が残ると、次の回も同じpushを繰り返す(通知は出ない)。
    log.warn("could not clear the ended schedule freezes, will push again", {
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
  }
}

// ---------------------------------------------------------------------------
// ジョブ全体の上限の見積もり
// ---------------------------------------------------------------------------

/**
 * 1回の実行で走るgitの最大回数。
 * cloneの更新(`FACTORY_CLONE_UPDATE_GIT_COMMAND_COUNT`回)、HEADとブランチの確認で2回、
 * 変更パスの列挙で1回、反映に含まれるPRの列挙(`git log`)で1回、`mise.toml`の比較(`git show`)で最大2回。
 * `git show`は時間切れでも失敗として続くので、最大回数まで走りうる。
 * 上限は`DEFAULT_TIMEOUT_MS`である。ホストの印の確認は`SELF_UPDATE_LOCAL_GIT_COMMAND_COUNT`に数える。
 */
export const SELF_UPDATE_GIT_COMMAND_COUNT =
  FACTORY_CLONE_UPDATE_GIT_COMMAND_COUNT + 2 + 1 + 1 + 2;

/**
 * 1回の実行で走る、ローカルだけのgit(上限は`SELF_UPDATE_LOCAL_GIT_TIMEOUT_MS`)の最大回数。
 * ホストの印の確認は、コミットの有無で1回、祖先の確認と内容の比較でそれぞれ最大`HOST_ACTION_RECONCILE_LIMIT + 1`回
 * (通知の解決で上限の数まで、この回の通知の判断で1回)。
 */
export const SELF_UPDATE_LOCAL_GIT_COMMAND_COUNT =
  1 + 2 * (HOST_ACTION_RECONCILE_LIMIT + 1);

/** 1回の実行で走る`wmill sync push`と`wmill datatable migrate up`の回数。 */
export const SELF_UPDATE_CLI_COMMAND_COUNT = 2;

/**
 * 収集の鮮度の確認の中で、`SELF_UPDATE_CALL_TIMEOUT_MS`で区切った呼び出しの箇所の数。
 * stateの読み、stateの書き、収集の記録の読み、リポジトリ単位の古さの読み、未解決のnoticeの一覧、noticeの挿入、noticeの解決、通知先の取得の8か所である。
 * この8か所は確認全体の上限(`GH_COLLECT_FRESHNESS_CHECK_TIMEOUT_MS`)に包まれるので、
 * 最悪の長さには箇所の数としては数えず、上限を1回だけ数える。
 * この数え方は、次の3つがすべて成り立つときだけ成り立つ。
 * - 確認の呼び出しが、finallyの最後の文である。呼び出し元が上限で戻った後に、背景の処理の後ろで待たされる区切りの呼び出しも、
 *   背景の処理と競合する後続の処理も無い。
 * - 確認が子プロセスを起動しない。ジョブの`timeout`は子プロセスが残るのを防ぐ最後の打ち切りで、
 *   背景の処理が子プロセスを持たなければ、打ち切られても残るものが無い。
 * - 区切りの時間切れの後に中断されずに残る背景の処理は数えない(`SELF_UPDATE_WORST_CASE_MS`の前提)。
 * 条件は`tests/scripts/self_update_gh_collect_freshness.test.ts`が固定する。
 */
export const GH_COLLECT_FRESHNESS_BOUNDED_CALL_COUNT = 8;

/**
 * 1回の実行で通りうる、`SELF_UPDATE_CALL_TIMEOUT_MS`で区切った呼び出しの最大回数。通知は含めない。
 * - config(`getResource`): 1
 * - 更新: github_token、deployed_sha、deployed_shaの読み取りが失敗したときの存在の確認、wmill_token、
 *   `setVariable`、`setVariable`が時間切れのときの読み直し、
 *   `recordDeployment`の成功、`recordDeployment`の失敗: 8
 *   (成功の記録と失敗の記録は一方しか通らないが、呼び出しの箇所を数えるので両方を数える)
 * - finally(Console用workerの確認): stateの読み、stateの書き、noticeの挿入、通知先の取得: 4
 * - finally(定期ジョブ用workerの確認): noticeの挿入、noticeの解決、通知先の取得: 3
 *   (この3つは確認全体の上限(`PERIODIC_WORKER_CHECK_TIMEOUT_MS`)の中に収まるので、
 *   最悪の合計では二重に数えている。テストが呼び出しの箇所を数えるため、
 *   Console用workerの確認の4つと同じ数え方にそろえ、余裕として残す)
 * - ホスト側の作業の通知: 印の読み取り、未解決の通知の一覧、通知の解決(上限の数まで)、
 *   noticeの挿入、通知先の取得: 4 + `HOST_ACTION_RECONCILE_LIMIT`
 * - 止まった作業項目の再開の候補の確認(候補の一覧と要件の承認の読み)と起動: 2
 * - `factory_repo_id`の照合: リポジトリIDの取得、失敗の記録、noticeの挿入: 3
 *   (`gh api`の子プロセスは`DEFAULT_TIMEOUT_MS`が上限だが、ここで先に区切る)
 * - finally(収集の鮮度の確認): `GH_COLLECT_FRESHNESS_BOUNDED_CALL_COUNT`
 *   (最悪の長さでは、この箇所を除いて確認全体の上限を数える)
 */
export const SELF_UPDATE_BOUNDED_CALL_COUNT =
  13 +
  4 +
  3 +
  HOST_ACTION_RECONCILE_LIMIT +
  2 +
  3 +
  GH_COLLECT_FRESHNESS_BOUNDED_CALL_COUNT;

/**
 * finallyの通知1回の上限(ミリ秒)。
 * `notify`は、HTTPの送信、429の待ち(最大`DISCORD_RETRY_MAX_WAIT_MS`)、再送の順に進み、
 * 送信には上限が無い。そこで送信ごとに`SELF_UPDATE_CALL_TIMEOUT_MS`で中断し(`boundedFetch`)、
 * 全体の上限は、待ちと送信2回に、応答の読み取りの余裕1回分を足した値にする。
 */
export const SELF_UPDATE_NOTIFY_TIMEOUT_MS =
  DISCORD_RETRY_MAX_WAIT_MS + 3 * SELF_UPDATE_CALL_TIMEOUT_MS;

/** 送信を`SELF_UPDATE_CALL_TIMEOUT_MS`で中断する`fetch`。 */
const boundedFetch: FetchLike = (url, init) =>
  fetch(url, {
    ...init,
    signal: AbortSignal.timeout(SELF_UPDATE_CALL_TIMEOUT_MS),
  });

/**
 * 全部が最悪のときの、1回の実行の長さ(ミリ秒)。`self_update.script.yaml`の`timeout`は、これ以上にする。
 * ジョブの`timeout`はWindmillが外から打ち切る最後の砦で、子プロセスの実行中に当たると、
 * 子が上限なしで残りうる(`runCommand`は子を別のセッションで起動する)。
 * - cloneのロック待ち(最大の待ちと、確かめる間隔1回)
 * - コマンド: 上限に、停止の上乗せ(`RUNNER_MAX_STOP_OVERHEAD_MS`)を足した時間の、回数分
 * - 区切った呼び出し: 上限の回数分
 * - 通知: ホスト側の作業の通知とfinallyの通知の2回
 * - Console用workerの確認
 * - 定期ジョブ用workerの確認
 * - 凍結の段(読む段と書く段。各段を`FREEZE_PHASE_TIMEOUT_MS`の1つの上限で包み、区切った呼び出しの回数には数えない)
 * - 収集の鮮度の確認(全体の上限を1回。中の区切った呼び出しは、区切った呼び出しの回数から除く)
 * - 設計の有効化の通知の処理(全体の上限を1回。中の呼び出しは、`withCallTimeout`の1つの区切りに包み、区切った呼び出しの回数には数えない)
 * 区切りの時間切れの後に、中断されずに残る背景の処理は数えない。
 */
export const SELF_UPDATE_WORST_CASE_MS =
  REPO_LOCK_MAX_WAIT_MS +
  REPO_LOCK_POLL_MS +
  SELF_UPDATE_GIT_COMMAND_COUNT *
    (DEFAULT_TIMEOUT_MS + RUNNER_MAX_STOP_OVERHEAD_MS) +
  SELF_UPDATE_LOCAL_GIT_COMMAND_COUNT *
    (SELF_UPDATE_LOCAL_GIT_TIMEOUT_MS + RUNNER_MAX_STOP_OVERHEAD_MS) +
  SELF_UPDATE_CLI_COMMAND_COUNT *
    (WMILL_CLI_TIMEOUT_MS + RUNNER_MAX_STOP_OVERHEAD_MS) +
  (SELF_UPDATE_BOUNDED_CALL_COUNT - GH_COLLECT_FRESHNESS_BOUNDED_CALL_COUNT) *
    SELF_UPDATE_CALL_TIMEOUT_MS +
  2 * SELF_UPDATE_NOTIFY_TIMEOUT_MS +
  SELF_UPDATE_FREEZE_PHASE_COUNT * FREEZE_PHASE_TIMEOUT_MS +
  CONSOLE_WORKER_CHECK_TIMEOUT_MS +
  PERIODIC_WORKER_CHECK_TIMEOUT_MS +
  GH_COLLECT_FRESHNESS_CHECK_TIMEOUT_MS +
  DESIGN_NOTICE_CHECK_TIMEOUT_MS;

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export type SelfUpdateResult =
  | { readonly outcome: "unchanged" }
  | { readonly outcome: "skipped"; readonly reason: "factory_repo_id" }
  | { readonly outcome: "held"; readonly reason: "deploy_freeze" }
  | {
      readonly outcome: "updated";
      readonly sha_from: string | null;
      readonly sha_to: string;
      readonly needs_host_action: boolean;
    };

type FactoryConfig = Awaited<ReturnType<typeof loadConfig>>;

/** 定期ジョブ用workerの不在の通知を、待ちが解けて自動で解決するときの、解決者の名前。 */
const PERIODIC_WORKER_NOTICE_RESOLVER = "self_update";

/** 収集の鮮度のnoticeを、回復や設定の変更で自動で解決するときの、解決者の名前。 */
const GH_COLLECT_NOTICE_RESOLVER = "self_update";

/**
 * 自己更新を行い、そのあとでConsole用workerと定期ジョブ用workerが受けているかと、GitHubの収集が成功しているかを確かめる。
 * 確認は更新の成否によらず毎回行う。Console用workerがジョブを受けないとConsoleのジョブが溜まり続けるため。
 * 定期ジョブ用workerがジョブを受けないと、tag periodicを付けた定期ジョブが溜まり続けるため。
 * 収集が止まると、記録が更新されないまま誰にも知らされないため。
 * 確認は時間を区切り、失敗しても例外を投げないので、更新の結果は変わらない。
 */
export async function main(): Promise<SelfUpdateResult> {
  const log = logger("self_update");
  const config = await loadConfig(() =>
    withCallTimeout("getResource factory_config", () =>
      wmill.getResource("f/factory/factory_config"),
    ),
  );
  // `design_enabled`が偽として読まれたことの通知を整える。更新の前に、全体を1つの上限で包んで行う。
  // 失敗しても時間切れでも、更新と検知は止めない。
  try {
    await withCallTimeout(
      "design notice check",
      () =>
        reconcileDesignEnabledNotice({
          ignored: config.design_enabled_ignored,
          addNotice: (record) => addNoticeUnlessUnresolved(record),
          listUnresolved: () =>
            listUnresolvedNoticesByKind(DESIGN_ENABLED_IGNORED_NOTICE_KIND),
          resolve: (id) =>
            resolveNoticeIfUnresolved(
              id,
              DESIGN_ENABLED_IGNORED_NOTICE_KIND,
              "self_update",
              [],
            ),
          log,
        }),
      DESIGN_NOTICE_CHECK_TIMEOUT_MS,
    );
  } catch (err) {
    log.warn("design notice check failed", {
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
  }
  try {
    return await updateSelf(log, config);
  } finally {
    // 更新が例外を投げても検知は走らせる。更新が失敗し続けると、Console用workerの停止に誰も気づけなくなるため。
    await watchConsoleWorker({
      listWaitingJobs: () =>
        wmill.JobService.listQueue(
          consoleQueueQuery(wmillDefault.getWorkspace()),
        ),
      listRecentWatchRuns: () =>
        wmill.JobService.listCompletedJobs(
          watchRunsQuery(wmillDefault.getWorkspace()),
        ),
      now: () => Date.now(),
      addNotice: (record) =>
        withCallTimeout("addNotice", () => addNoticeUnlessUnresolved(record)),
      notify: async (event) => {
        const webhookUrl = await withCallTimeout("getVariable webhook", () =>
          wmill.getVariable("f/factory/discord_webhook_url"),
        );
        await withCallTimeout(
          "notify",
          () =>
            notifyBestEffort(webhookUrl, event, log, { fetch: boundedFetch }),
          SELF_UPDATE_NOTIFY_TIMEOUT_MS,
        );
      },
      getState: () => withCallTimeout("getState", () => wmill.getState()),
      setState: (state) =>
        withCallTimeout("setState", () => wmill.setState(state)),
      instanceName: config.instance_name,
      log,
    });
    // 定期ジョブ用workerの確認も、更新の成否によらず走らせる。時間を区切り、例外は投げない。
    const periodicWorker = await checkPeriodicWorker({
      listWaitingJobs: () =>
        wmill.JobService.listQueue(
          periodicQueueQuery(wmillDefault.getWorkspace()),
        ),
      now: () => Date.now(),
      addNotice: (record) =>
        withCallTimeout("addNotice", () => addNoticeUnlessUnresolved(record)),
      resolveNotices: (kind, messagePrefix) =>
        withCallTimeout("resolveNotices", () =>
          resolveUnresolvedNoticesByPrefix(
            kind,
            messagePrefix,
            PERIODIC_WORKER_NOTICE_RESOLVER,
          ),
        ),
      notify: async (event) => {
        const webhookUrl = await withCallTimeout("getVariable webhook", () =>
          wmill.getVariable("f/factory/discord_webhook_url"),
        );
        await withCallTimeout(
          "notify",
          () =>
            notifyBestEffort(webhookUrl, event, log, { fetch: boundedFetch }),
          SELF_UPDATE_NOTIFY_TIMEOUT_MS,
        );
      },
      instanceName: config.instance_name,
      log,
    });
    // 収集の鮮度の確認は、finallyの最後の文にする。最悪の長さの数え方がこの位置に頼る
    // (`GH_COLLECT_FRESHNESS_BOUNDED_CALL_COUNT`を参照)。確認は例外を投げないが、念のため包む。
    try {
      await checkGhCollectFreshness({
        enabled: config.gh_collect_enabled,
        detailEnabled: config.gh_collect_detail_enabled,
        nonExplicitPossible: nonExplicitReposPossible(config),
        owners: config.owners.map((owner) => owner.name),
        periodicStalled: periodicWorker === "stalled",
        now: () => Date.now(),
        listFreshness: (owners) =>
          withCallTimeout("listGhCollectFreshness", () =>
            listGhCollectFreshness(owners),
          ),
        listRepoStale: (owners, thresholdMs) =>
          withCallTimeout("listGhRepoStale", () =>
            listGhRepoStaleSnapshot(owners).then((snapshot) =>
              summarizeRepoStale({
                snapshot,
                owners,
                staleAfterMs: thresholdMs,
                settledAfterMs: ghDetailStaleAfterMs(owners.length),
                isTarget: repoStaleTargetFilter(config),
              }),
            ),
          ),
        getState: () => withCallTimeout("getState", () => wmill.getState()),
        setState: (state) =>
          withCallTimeout("setState", () => wmill.setState(state)),
        listStaleNotices: () =>
          withCallTimeout("listStaleNotices", () =>
            listUnresolvedNoticesByKind(GH_COLLECT_STALE_KIND),
          ),
        addNotice: (record) =>
          withCallTimeout("addNotice", () => addNoticeUnlessUnresolved(record)),
        resolveNotices: (messagePrefix) =>
          withCallTimeout("resolveNotices", () =>
            resolveUnresolvedNoticesByPrefix(
              GH_COLLECT_STALE_KIND,
              messagePrefix,
              GH_COLLECT_NOTICE_RESOLVER,
            ),
          ),
        noticeUrl: (noticeId) =>
          buildNoticeConsoleUrl(config.windmill_public_url, noticeId),
        notify: async (event) => {
          const webhookUrl = await withCallTimeout("getVariable webhook", () =>
            wmill.getVariable("f/factory/discord_webhook_url"),
          );
          await withCallTimeout(
            "notify",
            () =>
              notifyBestEffort(webhookUrl, event, log, { fetch: boundedFetch }),
            SELF_UPDATE_NOTIFY_TIMEOUT_MS,
          );
        },
        instanceName: config.instance_name,
        log,
      });
    } catch {
      log.warn("gh collect freshness check failed");
    }
  }
}

/**
 * イメージが古くて止まった作業項目の再開を、別のジョブで始める。例外は投げない。
 * 再開するものが無ければ、そのジョブは何もせずに終わる。
 * 再開は、フローの起動や状態の確認を伴い、自己更新の長さを延ばすためである。
 * 起動に失敗しても、止まった作業項目は`retry_work_item`で再開できるので、警告のログだけを残す。
 */
async function startStaleImageRetry(log: Logger): Promise<void> {
  try {
    const jobId = await withCallTimeout("start auto retry", () =>
      wmill.runScriptByPathAsync("f/factory/auto_retry_stale_image", {}),
    );
    log.info("auto retry of the stale image items started", { job_id: jobId });
  } catch (err) {
    log.warn("auto retry of the stale image items could not be started", {
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
  }
}

/**
 * 照合の失敗を`job_failures`に残す。例外は投げない。
 * 記録に失敗しても、照合に落ちた回の扱い(反映しない)は変わらないため、ログだけ残す。
 */
async function recordGateFailure(
  step: string,
  err: unknown,
  log: Logger,
): Promise<void> {
  const message = maskSecrets(err instanceof Error ? err.message : String(err));
  log.error(step, { error: message });
  try {
    await withCallTimeout("recordFailure factory_repo_id", () =>
      recordFailure({
        work_item_id: null,
        flow_path: "f/factory/self_update",
        job_id: process.env.WM_JOB_ID ?? "unknown",
        step,
        error: message,
      }),
    );
  } catch (recordErr) {
    log.error("failed to record failure", {
      error: maskSecrets(
        recordErr instanceof Error ? recordErr.message : String(recordErr),
      ),
    });
  }
}

async function updateSelf(
  log: Logger,
  config: FactoryConfig,
): Promise<SelfUpdateResult> {
  // 同じ範囲の反映が重なったとき、どの起動が重なったかを後から追えるよう、起動の種類を毎回残す。
  // 種類の判定が外れたときに原因を切り分けられるよう、判定の入力も添える。
  log.info("self_update started", {
    trigger: resolveTriggerKind(process.env),
    job_id: process.env.WM_JOB_ID ?? "unknown",
    ...describeTriggerEnv(process.env),
  });

  const ghToken = await withCallTimeout("getVariable github_token", () =>
    wmill.getVariable("f/factory/github_token"),
  );

  // 取得の前に、`factory_repo`が指すリポジトリのIDを照合する。
  // 食い違うリポジトリの内容を、秘密値を持つworkspaceへ反映しないためである。
  // 食い違い、404、URLの誤りの回は、self cloneも更新せず、次の回に照合し直す。
  // それ以外の照合の失敗(認証、5xx、レート制限、通信断)は、ジョブの失敗にする。
  let factoryClone: Awaited<ReturnType<typeof ensureVerifiedFactoryClone>>;
  try {
    factoryClone = await ensureVerifiedFactoryClone(
      config,
      { run: runCommand, ghToken },
      {
        getRepositoryId: (owner, repo) =>
          withCallTimeout("getRepositoryId factory_repo", () =>
            getRepositoryId({ ghToken, run: runCommand }, owner, repo),
          ),
        addNotice: (record) =>
          withCallTimeout("addNotice factory_repo_id", () =>
            addNoticeUnlessUnresolved(record),
          ),
      },
    );
  } catch (err) {
    if (!(err instanceof FactoryRepoIdMismatchError)) {
      throw err;
    }
    await recordGateFailure("verify_factory_repo_id", err, log);
    log.warn("factory_repo id check did not pass, skipping the update");
    return { outcome: "skipped", reason: "factory_repo_id" };
  }

  // `ensureFactoryClone`の事後条件を鵜呑みにせず、ブランチを重ねて確かめる
  // (理由は`readSelfCloneBranch`のコメントを参照)。
  const actualBranch = await readSelfCloneBranch(runCommand, factoryClone.dir);
  assertBranchMatches(actualBranch, config.factory_branch, factoryClone.dir);

  const currentSha = await readSelfCloneHeadSha(runCommand, factoryClone.dir);

  // 印の読み取りとself cloneでの確認は、通知の解決とこの回の通知の判断(`recordHostAction`)で使い回す。
  const hostApplied = hostAppliedChecker({
    readAppliedSha: () =>
      withCallTimeout("read host applied sha", () => readHostAppliedSha()),
    commitExists: (sha) => isCommitInClone(runCommand, factoryClone.dir, sha),
    isAncestor: (ancestor, descendant) =>
      isAncestorSha(runCommand, factoryClone.dir, ancestor, descendant),
    differingPaths: (from, to) =>
      listDifferingPaths(runCommand, factoryClone.dir, from, to),
    log,
  });
  // ホストで反映が済んだ通知を解決する。反映が不要な回でも、反映の後でも呼ぶ。
  // 反映の判断を遅らせないよう、反映の判断と記録より後に呼ぶ。
  // イメージが古くて止まった作業項目の再開は、通知を解決した回と、候補が残っている回だけ始める。
  // 候補の選び方は繰り返しても同じ結果になるので、前の回で取り逃した項目も拾える。
  // 何もしないジョブを2分ごとに起動しないよう、どちらでもない回は起動しない。
  const resolveHostActionNotices = async () => {
    const resolved = await reconcileHostActionNotices({
      listUnresolved: () =>
        withCallTimeout("list host action notices", () =>
          listUnresolvedNoticesByKind(HOST_ACTION_NOTICE_KIND),
        ),
      isApplied: hostApplied,
      resolve: (id) =>
        withCallTimeout("resolve host action notice", () =>
          resolveNoticeIfUnresolved(
            id,
            HOST_ACTION_NOTICE_KIND,
            HOST_ACTION_RESOLVER,
            [],
          ),
        ),
      log,
    });
    if (
      await shouldStartStaleImageRetry({
        resolvedCount: resolved,
        hasCandidates: () =>
          withCallTimeout("check auto retry candidates", () =>
            hasRetryableCandidate({
              implementEnabled: config.implement_enabled,
              listCandidates: () =>
                listAutoRetryCandidates(
                  autoRetryCandidateQuery(AUTO_RETRY_LIST_LIMIT),
                ),
              isImplementReady: async (candidate) =>
                isRequirementsApprovedForAttempt(
                  await latestRequirementsApproval(candidate.id),
                  candidate.attempt,
                ),
            }),
          ),
        log,
      })
    ) {
      await startStaleImageRetry(log);
    }
    return resolved;
  };

  // 変数が無いと確かめられたときだけ未デプロイ(空)として扱う(`readDeployedSha`を参照)。
  const deployedSha = await readDeployedSha(
    () => wmill.getVariable("f/factory/deployed_sha"),
    () =>
      wmill.VariableService.existsVariable({
        workspace: wmillDefault.getWorkspace(),
        path: "f/factory/deployed_sha",
      }),
  );

  const decision = decideUpdate(currentSha, deployedSha);
  // 凍結中のスケジュールを除いて反映した回の後、凍結が終わったら、shaが変わらなくても
  // pushだけをやり直して設定を戻す(migrationと`deployed_sha`の更新はしない)。
  const freeze = await prepareFreezePlan(factoryClone.dir);
  const action = chooseFreezeAction(decision.outcome === "unchanged", freeze);
  const reconcileOnly = action === "reconcile";
  if (action === "skip") {
    if (!freeze.ok) {
      log.warn("could not read the schedule freezes, nothing to deploy", {
        error: maskSecrets(freeze.reason),
      });
    }
    log.info("self clone unchanged, nothing to deploy", { sha: currentSha });
    await resolveHostActionNotices();
    return { outcome: "unchanged" };
  }

  // deployの保留が有効なあいだは反映全体(push、migration、`deployed_sha`の更新)を待つ。
  // 凍結を読めたときだけ判定する。読めない回は、下で失敗として記録する。
  // 失敗の行を足す`try`の前で戻るので、トークンの取得などの例外でも、見送った回に失敗の行は足さない。
  // `deployed_sha`を進めないので、保留が切れた最初の回が同じ範囲をそのまま反映する。
  // `reason`と`holder`は信頼できない文字列なので、ログにはidと期限だけを出す。
  if (freeze.ok && shouldHoldDeploy(freeze.value)) {
    log.info("a deploy freeze is active, deferring the deployment", {
      freezes: freeze.value.deployFreezes,
      sha_from: deployedSha,
      sha_to: currentSha,
    });
    await resolveHostActionNotices();
    return { outcome: "held", reason: "deploy_freeze" };
  }

  log.info(
    reconcileOnly
      ? "schedule freezes ended, pushing again"
      : "self clone changed, deploying",
    {
      sha_from: deployedSha,
      sha_to: currentSha,
    },
  );

  // 下でトークンを取得した時点で埋め、外側のcatchの`maskSecrets`でも使う。
  // 両方から参照できるよう、ここで宣言する。
  let secrets: string[] = [];
  // `deployed_sha`を更新した後は反映が済んでいる。その後の失敗は、失敗の反映として記録しない。
  let deployedShaUpdated = false;

  try {
    const wmillToken = await withCallTimeout("getVariable wmill_token", () =>
      wmill.getVariable("f/factory/wmill_token"),
    );
    secrets = [wmillToken];
    const context = resolveWmillCliContext({
      BASE_INTERNAL_URL: process.env.BASE_INTERNAL_URL,
      BASE_URL: process.env.BASE_URL,
      WM_WORKSPACE: process.env.WM_WORKSPACE,
    });
    const env = buildWmillEnv({
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      TMPDIR: jobTmpEnv().TMPDIR,
    });

    await assertWmillYamlExists(factoryClone.dir);

    // 凍結を読めない回は反映しない(安全側)。投げた理由は失敗の記録に載る。
    if (!freeze.ok) {
      throw new Error(`schedule freezes: ${freeze.reason}`);
    }
    const plan = freeze.value;
    for (const warning of plan.warnings) log.warn(warning);

    await runWmillCli(
      buildWmillArgv(
        ["wmill", "sync", "push", "--yes", "--keep-deleted", plan.excludesArg],
        context,
        wmillToken,
      ),
      factoryClone.dir,
      env,
      log,
      "wmill sync push",
      secrets,
    );
    await finishFreezePlan(plan, log);
    if (reconcileOnly) {
      await resolveHostActionNotices();
      return { outcome: "unchanged" };
    }
    await runWmillCli(
      buildWmillArgv(
        ["wmill", "datatable", "migrate", "up"],
        context,
        wmillToken,
      ),
      factoryClone.dir,
      env,
      log,
      "wmill datatable migrate up",
      secrets,
    );

    const { changedPaths, classification } = await advanceDeployedSha({
      setSha: () =>
        setDeployedSha(
          {
            set: () =>
              wmill.setVariable(
                "f/factory/deployed_sha",
                currentSha,
                false,
                "Software Factory自身のうち、直近でWindmillに反映済みのコミットです。自己更新処理が自動的に更新します。",
              ),
            get: () => wmill.getVariable("f/factory/deployed_sha"),
          },
          currentSha,
        ),
      onUpdated: () => {
        deployedShaUpdated = true;
      },
      listChangedPaths: () =>
        resolveChangedPaths(
          runCommand,
          factoryClone.dir,
          deployedSha,
          currentSha,
        ),
      hostSectionsChanged: () =>
        miseTomlHostSectionsChanged(
          runCommand,
          factoryClone.dir,
          deployedSha,
          currentSha,
        ),
    });

    // PRの一覧は表示のための付随情報なので、取れなくても反映の成功を失敗にしない。
    let pullRequests: DeploymentPullRequest[] = [];
    try {
      pullRequests = await listMergedPullRequests(
        runCommand,
        factoryClone.dir,
        deployedSha,
        currentSha,
        config.factory_repo,
      );
    } catch (err) {
      log.warn("failed to list merged pull requests", {
        error: maskSecrets(err instanceof Error ? err.message : String(err)),
      });
    }

    const shaFrom = deployedSha.length > 0 ? deployedSha : null;
    // 記録の時間切れは、反映が済んでいるので失敗にせず、警告だけ残す。
    await recordSuccessDeployment(
      () =>
        recordDeployment({
          sha_from: shaFrom,
          sha_to: currentSha,
          changed_paths: changedPaths,
          result: "success",
          needs_host_action: classification.needs_host_action,
          pull_requests: pullRequests,
          error: null,
        }),
      (timeout) => {
        log.warn("recording the successful deployment timed out", {
          error: timeout.message,
          sha_to: currentSha,
        });
      },
    );

    if (classification.needs_host_action) {
      // `infra/`と`mise.toml`の変更はworkerの中からは反映できず、人が
      // ホストで`mise run up`するまで効かない。気づけるよう通知で知らせる。
      // 反映は済んでいるので、通知の失敗では更新を失敗にしない。
      log.info("host-side changes need mise run up", {
        host_paths: classification.host_paths,
      });
      await recordHostAction(
        {
          addNotice: (record) =>
            withCallTimeout("addNotice host action", () =>
              addNoticeUnlessUnresolved(record),
            ),
          notify: async (event) => {
            const webhookUrl = await withCallTimeout(
              "getVariable webhook host action",
              () => wmill.getVariable("f/factory/discord_webhook_url"),
            );
            return await withCallTimeout(
              "notify",
              () =>
                notifyBestEffort(webhookUrl, event, log, {
                  fetch: boundedFetch,
                }),
              SELF_UPDATE_NOTIFY_TIMEOUT_MS,
            );
          },
          isApplied: hostApplied,
          instanceName: config.instance_name,
          log,
        },
        currentSha,
        classification.host_paths,
      );
    }

    await resolveHostActionNotices();

    return {
      outcome: "updated",
      sha_from: shaFrom,
      sha_to: currentSha,
      needs_host_action: classification.needs_host_action,
    };
  } catch (err) {
    log.error("self_update failed", {
      error: deploymentFailureMessage(err, secrets),
    });
    // 理由はログと同じ伏せ字処理を通して記録する。記録に失敗しても元の例外を投げる。
    // 凍結の追従だけの回は、反映の対象のコミットが無いので、失敗の行を足さない(次の回が再試行する)。
    // `deployed_sha`の更新後は反映が済んでいるので、失敗の行を足さない。
    if (!reconcileOnly && !deployedShaUpdated) {
      await recordFailedDeployment(
        {
          record: (record) => recordDeployment(record),
          onRecordError: (message) => {
            log.error("failed to record deployment", { error: message });
          },
        },
        {
          shaFrom: deployedSha.length > 0 ? deployedSha : null,
          shaTo: currentSha,
          error: err,
          secrets,
        },
      );
    }
    throw err;
  }
}
