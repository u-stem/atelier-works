// 10分ごとに、Factory自身のself clone(`/workspaces/factory/atelier-works`)を
// pullする。前回記録したデプロイからHEADが進んでいれば、worker自身の中から
// Windmillの定義をpushし、未適用のData Tableのmigrationを適用する。
//
// 判断と整形の純粋なロジック(再デプロイが要るか、どの変更パスがworkerの中から
// は反映できずホスト側の次回起動で反映されるか、`wmill` CLIの子プロセスに渡す
// 最小のenv)は`./lib/self_update_support.ts`にあり、このファイルは入出力を
// つなぐだけ。`infra/`と`mise.toml`の変更は次の`mise run up`で反映されるため、
// 通知はせずログと`deployments`の記録だけを残す。
//
// `f/factory/deployed_sha`(秘密でないWindmillの変数)はsyncの対象から
// 完全に外している(`wmill.yaml`の`excludes`のコメントを参照)。
// `scripts/bootstrap.sh`が空の値で一度だけ作り、以降は下の
// `wmill.setVariable`だけが値を変える。無関係な`wmill sync push`で戻らない。
import * as wmill from "windmill-client@1.817.0";
import { loadConfig } from "./lib/config.ts";
import { checkConsoleWorker } from "./lib/console_worker.ts";
import { addNoticeUnlessUnresolved, recordDeployment } from "./lib/db.ts";
import { type Logger, logger, maskSecrets } from "./lib/log.ts";
import {
  assertBranchMatches,
  buildNpmCiArgv,
  buildWmillArgv,
  buildWmillEnv,
  classifyChangedPaths,
  decideUpdate,
  MISE_TOML_PATH,
  miseTomlNeedsHostAction,
  parseNulSeparatedPaths,
  RAW_APP_RELATIVE_DIR,
  resolveWmillCliContext,
  truncateOutput,
} from "./lib/self_update_support.ts";
import { assertSha } from "./lib/types.ts";
import {
  type CommandResult,
  type CommandRunner,
  ensureFactoryClone,
  pathExists,
  runCommand,
} from "./lib/workspace.ts";

// ---------------------------------------------------------------------------
// self cloneのgit操作。判断を含まない単発のgitの入出力なので、
// libに出さずこのscriptに閉じる(`poll_issues.ts`の`readRepoHeadSha`と同じ)。
// ---------------------------------------------------------------------------

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
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
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
// main
// ---------------------------------------------------------------------------

export type SelfUpdateResult =
  | { readonly outcome: "unchanged" }
  | {
      readonly outcome: "updated";
      readonly sha_from: string | null;
      readonly sha_to: string;
      readonly needs_host_action: boolean;
    };

export async function main(): Promise<SelfUpdateResult> {
  const log = logger("self_update");
  const config = await loadConfig(() =>
    wmill.getResource("f/factory/factory_config"),
  );
  // Console用workerが居ないとConsoleのjobが溜まり続けるので、更新の有無によらず毎回確かめる。
  // 確かめられなくても自己更新は止めない(`checkConsoleWorker`は例外を投げない)。
  await checkConsoleWorker({
    listWorkers: (page, pingSince) =>
      wmill.WorkerService.listWorkers({ page, perPage: 100, pingSince }),
    addNotice: (record) => addNoticeUnlessUnresolved(record),
    log,
  });
  const ghToken = await wmill.getVariable("f/factory/github_token");

  const factoryClone = await ensureFactoryClone({
    run: runCommand,
    repoUrl: config.factory_repo,
    ghToken,
    branch: config.factory_branch,
  });

  // `ensureFactoryClone`の事後条件を鵜呑みにせず、ブランチを重ねて確かめる
  // (理由は`readSelfCloneBranch`のコメントを参照)。
  const actualBranch = await readSelfCloneBranch(runCommand, factoryClone.dir);
  assertBranchMatches(actualBranch, config.factory_branch, factoryClone.dir);

  const currentSha = await readSelfCloneHeadSha(runCommand, factoryClone.dir);

  let deployedSha = "";
  try {
    deployedSha = await wmill.getVariable("f/factory/deployed_sha");
  } catch {
    deployedSha = ""; // 変数がまだ無いときは、未デプロイとして扱う。
  }

  const decision = decideUpdate(currentSha, deployedSha);
  if (decision.outcome === "unchanged") {
    log.info("self clone unchanged, nothing to deploy", { sha: currentSha });
    return { outcome: "unchanged" };
  }

  log.info("self clone changed, deploying", {
    sha_from: deployedSha,
    sha_to: currentSha,
  });

  // 下でトークンを取得した時点で埋め、外側のcatchの`maskSecrets`でも使う。
  // 両方から参照できるよう、ここで宣言する。
  let secrets: string[] = [];

  try {
    const wmillToken = await wmill.getVariable("f/factory/wmill_token");
    secrets = [wmillToken];
    const context = resolveWmillCliContext({
      BASE_INTERNAL_URL: process.env.BASE_INTERNAL_URL,
      BASE_URL: process.env.BASE_URL,
      WM_WORKSPACE: process.env.WM_WORKSPACE,
    });
    const env = buildWmillEnv({
      HOME: process.env.HOME,
      PATH: process.env.PATH,
    });

    await assertWmillYamlExists(factoryClone.dir);

    // Consoleのraw appは`wmill sync push`がこのcloneからバンドルするので、
    // npmの依存が最新の状態で揃っている必要がある(新しいコミットで足した依存は、
    // それ以前に入れた`node_modules`には無い)。`npm ci`は`package-lock.json`を
    // 書き換えず、固定された版をそのまま入れる(`buildNpmCiArgv`を参照)。
    const rawAppDir = `${factoryClone.dir}/${RAW_APP_RELATIVE_DIR}`;
    if (await pathExists(`${rawAppDir}/package-lock.json`)) {
      await runWmillCli(
        buildNpmCiArgv(rawAppDir),
        factoryClone.dir,
        env,
        log,
        "npm ci (raw app)",
        secrets,
      );
    }

    await runWmillCli(
      buildWmillArgv(
        ["wmill", "sync", "push", "--yes", "--keep-deleted"],
        context,
        wmillToken,
      ),
      factoryClone.dir,
      env,
      log,
      "wmill sync push",
      secrets,
    );
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

    await wmill.setVariable(
      "f/factory/deployed_sha",
      currentSha,
      false,
      "Software Factory自身のうち、直近でWindmillに反映済みのコミットです。自己更新処理が自動的に更新します。",
    );

    const changedPaths = await resolveChangedPaths(
      runCommand,
      factoryClone.dir,
      deployedSha,
      currentSha,
    );
    const miseChanged = changedPaths.includes(MISE_TOML_PATH)
      ? await miseTomlHostSectionsChanged(
          runCommand,
          factoryClone.dir,
          deployedSha,
          currentSha,
        )
      : false;
    const classification = classifyChangedPaths(changedPaths, miseChanged);

    if (classification.needs_host_action) {
      // `infra/`と`mise.toml`の変更はworkerの中からは反映できないが、
      // 次にホストで`mise run up`して起動したときにビルドされて反映される。
      // 人の操作は要らないので通知せず、ログと`deployments`の記録だけを残す。
      log.info("host-side changes will apply on next mise run up", {
        host_paths: classification.host_paths,
      });
    }

    const shaFrom = deployedSha.length > 0 ? deployedSha : null;
    await recordDeployment({
      sha_from: shaFrom,
      sha_to: currentSha,
      changed_paths: changedPaths,
      result: "success",
      needs_host_action: classification.needs_host_action,
    });

    return {
      outcome: "updated",
      sha_from: shaFrom,
      sha_to: currentSha,
      needs_host_action: classification.needs_host_action,
    };
  } catch (err) {
    const message = maskSecrets(
      err instanceof Error ? err.message : String(err),
      secrets,
    );
    log.error("self_update failed", { error: message });
    try {
      await recordDeployment({
        sha_from: deployedSha.length > 0 ? deployedSha : null,
        sha_to: currentSha,
        changed_paths: [],
        result: "failed",
        needs_host_action: false,
      });
    } catch (recordErr) {
      log.error("failed to record deployment", {
        error: maskSecrets(
          recordErr instanceof Error ? recordErr.message : String(recordErr),
        ),
      });
    }
    throw err;
  }
}
