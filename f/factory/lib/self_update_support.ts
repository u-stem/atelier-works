// `self_update.ts`の判定と整形を行う純粋関数群。
// I/Oは持たない。git・wmill CLIのサブプロセス、Data Tableへの記録、
// Discordへの通知は`self_update.ts`が行う。

// ---------------------------------------------------------------------------
// decideUpdate: 再デプロイが必要かの判定
// ---------------------------------------------------------------------------

export type UpdateDecision =
  | { readonly outcome: "unchanged" }
  | { readonly outcome: "update" };

/**
 * self cloneの現在のHEADのSHAを、Windmill変数`f/factory/deployed_sha`に
 * 記録された前回のSHAと比べる。
 * 空の`deployedSha`(初回のデプロイが成功する前の変数の初期値)は
 * 常に「異なる」とみなすため、最初の実行は必ずデプロイする。
 */
export function decideUpdate(
  currentSha: string,
  deployedSha: string,
): UpdateDecision {
  return currentSha === deployedSha
    ? { outcome: "unchanged" }
    : { outcome: "update" };
}

// ---------------------------------------------------------------------------
// assertBranchMatches: ensureFactoryCloneの事後条件の多層防御としての検査
// ---------------------------------------------------------------------------

/**
 * `actualBranch`が`expectedBranch`と異なれば例外を投げる。
 * `ensureFactoryClone`が本当にself cloneを`config.factory_branch`に
 * 置いたかを確かめる多層防御である。
 * `git pull --ff-only`だけではcheckout済みのブランチを進めるだけで、
 * 設定されたブランチへの切り替えも確認もしないため、実際のworkerで
 * `main`に留まったままになったことがある
 * (`lib/workspace.ts`の`ensureFactoryClone`のコメントを参照)。
 * `dir`は、例外のメッセージから対処できるようにするためだけに使う。
 */
export function assertBranchMatches(
  actualBranch: string,
  expectedBranch: string,
  dir: string,
): void {
  if (actualBranch !== expectedBranch) {
    throw new Error(
      `self_update: self clone at ${dir} is on branch "${actualBranch}", expected factory_branch "${expectedBranch}"`,
    );
  }
}

// ---------------------------------------------------------------------------
// classifyChangedPaths: 次のホスト側の`mise run up`で反映される変更パスと、CI経由で反映されるConsoleの変更パスの判定
// ---------------------------------------------------------------------------

/**
 * worker側の`wmill sync push` / `wmill datatable migrate up`では反映できず、
 * 次にホスト側で`mise run up`して起動したとき(workerイメージの再ビルド、
 * composeの再作成)に反映されるパス。
 * 無条件に該当するのは、workerイメージとcomposeの定義(`infra/**`)だけである。
 * `mise.toml`は`[tools]`(ツールのバージョン)か`[env]`(composeが読む値)が
 * 変わったときに限り該当する。タスク定義の編集は動作中のworkerに
 * 影響しない(`miseTomlNeedsHostAction`を参照)。
 * `scripts/**`(ホスト側の開発ツール)と`mise.local.toml.example`
 * (人向けのひな形)は動作中のworkerに影響しない。
 */
const HOST_ACTION_PATH_PATTERNS: readonly RegExp[] = [/^infra\//];

/**
 * Console(`console/`)のパス。`self_update`もホスト側の`mise run up`も関与せず、
 * mainへのマージの後、CIが組み立てた成果物を`console_fetcher`が取り込んで反映する。
 */
const CONSOLE_CI_PATH_PATTERNS: readonly RegExp[] = [/^console\//];

export const MISE_TOML_PATH = "mise.toml";

/**
 * 動作中のスタックが内容に依存する`mise.toml`のセクション。
 * `[tools]`はバージョン(workerイメージのツールのバージョンなど)を固定し、
 * `[env]`はdocker composeが埋め込む値を持つ。
 */
const MISE_HOST_SECTIONS: readonly string[] = ["tools", "env"];

/**
 * `mise.toml`から、ホストに関係するセクション(`[tools]`、`[env]`)の
 * 内容を取り出す。
 * 行単位で読み、`[name]`の見出しでセクションが始まり、次の見出しで終わる。
 * コメントだけの編集を変更と数えないよう、空行と`#`のコメントは落とす。
 */
export function extractMiseHostSections(toml: string): string {
  const kept: string[] = [];
  let current: string | null = null;
  for (const rawLine of toml.split("\n")) {
    const line = rawLine.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header !== null) {
      current = header[1] ?? null;
      continue;
    }
    if (current === null || !MISE_HOST_SECTIONS.includes(current)) continue;
    if (line.length === 0 || line.startsWith("#")) continue;
    kept.push(`${current}:${line}`);
  }
  return kept.join("\n");
}

/**
 * `mise.toml`の変更が次のホスト側の起動で反映する対象かを返す。
 * 2つの版で`[tools]` / `[env]`が異なるときに限り`true`を返す。
 * `oldToml === null`(比べる前回のデプロイが無い)の場合は、
 * 安全側に倒して必要とみなす。
 */
export function miseTomlNeedsHostAction(
  oldToml: string | null,
  newToml: string,
): boolean {
  if (oldToml === null) return true;
  return extractMiseHostSections(oldToml) !== extractMiseHostSections(newToml);
}

/**
 * `-z`付きのgitが出力するパス一覧(NULで区切り、末尾もNULで終わる)を
 * 配列にする。空の出力は空配列になる。
 * `-z`なしだと、非ASCIIや制御文字を含むパスは`core.quotepath`により
 * 引用符つきのエスケープ表記で出力され、`infra/`の判定に一致しなくなる。
 * `-z`ではパスがそのまま出力されるため、改行を含むパスも1件として扱える。
 */
export function parseNulSeparatedPaths(output: string): string[] {
  return output.split("\0").filter((path) => path.length > 0);
}

export type ChangedPathsClassification = {
  readonly needs_host_action: boolean;
  readonly host_paths: string[];
  readonly console_paths: string[];
};

/**
 * 変更されたファイルのパスの一覧(`git diff --name-only -z` /
 * `git ls-tree --name-only -z`の出力を`parseNulSeparatedPaths`で配列にしたもの)
 * を分類する。
 * `host_paths`は次のホスト側の起動で反映されるパス、`needs_host_action`は
 * それが1つ以上あるかを表す。
 * `console_paths`は、マージ後にCIと`console_fetcher`が反映するConsoleのパス。
 * `miseTomlHostSectionsChanged`は呼び出し側による`mise.toml`の判定
 * (`miseTomlNeedsHostAction`の結果)で、`paths`に`mise.toml`が
 * 含まれるときだけ意味を持つ。
 */
export function classifyChangedPaths(
  paths: readonly string[],
  miseTomlHostSectionsChanged: boolean,
): ChangedPathsClassification {
  const hostPaths = paths.filter(
    (path) =>
      HOST_ACTION_PATH_PATTERNS.some((pattern) => pattern.test(path)) ||
      (path === MISE_TOML_PATH && miseTomlHostSectionsChanged),
  );
  const consolePaths = paths.filter((path) =>
    CONSOLE_CI_PATH_PATTERNS.some((pattern) => pattern.test(path)),
  );
  return {
    needs_host_action: hostPaths.length > 0,
    host_paths: hostPaths,
    console_paths: consolePaths,
  };
}

// ---------------------------------------------------------------------------
// wmill CLIの接続: workspace・base-url・tokenをフラグで渡す
// ---------------------------------------------------------------------------
//
// workerコンテナは`wmill workspace add`を一度も実行しておらず、
// `WMILL_CONFIG_DIR`が空の状態で始まる。この状態から、Windmill CE 1.817.0の
// 実インスタンスに対して`wmill sync push --dry-run`を実行して確かめた結果
// (2026-09-26。`wmill datatable migrate up`も同じ)は次のとおり。
//   - `WM_WORKSPACE=<name>`だけでも`--workspace`の別名として認識される
//     ("Using workspace override: <name> (selected via --workspace)")。
//     ただし、そのworkspaceに対応するローカルに保存されたプロファイルが
//     必要で、空の設定ディレクトリには無いため、"No workspace profile found
//     for branch '<name>' ... Not a TTY, cannot create profile
//     interactively."で失敗する。
//   - `WM_BASE_URL`と`WM_TOKEN`は、単独でも`WM_WORKSPACE`と併用しても
//     まったく効かない。CLIは保存されたプロファイルを探して同じように失敗する。
//     環境変数だけに頼ると、workerでは"No workspace given and no default
//     set"で失敗する。
//   - 3つすべてをフラグ(`--workspace <ws> --base-url <url> --token <token>`)
//     で同時に渡したときに限り、CLIは保存されたプロファイルを探さない。
//     `wmill sync push --help`の"If used [--base-url], --token and
//     --workspace are required and no local remote/workspace already set
//     will be used"とも一致する。
//     ダミーのtokenでは"Could not authenticate ... Unauthorized"に達し
//     (workspaceとbase-urlの解決は成功している)、本物の
//     `f/factory/wmill_token`では`sync push --dry-run`が"0 changes to
//     apply"、`datatable migrate up`が"No pending migrations to run"という
//     正常な結果になることを、通しで確かめた。
// そのため、このCLIがtokenを読む環境変数は無く、tokenは引数に直接置くしかない。
// `scripts/bootstrap.sh`の冒頭コメントが`wmill workspace add --token`について
// 認めている例外(対話なしでtokenを渡す手段がほかに無い)と同じ扱いである。

export type WmillCliContextInput = {
  readonly BASE_INTERNAL_URL?: string | undefined;
  readonly BASE_URL?: string | undefined;
  readonly WM_WORKSPACE?: string | undefined;
};

export type WmillCliContext = {
  readonly workspace: string;
  readonly baseUrl: string;
};

/**
 * `--workspace` / `--base-url`の値を、Windmillがジョブに与える環境変数から
 * 決める。
 * これらは呼び出し側が選ぶものではなく、このジョブ自身のworkspaceを表すため、
 * 呼び出し側の引数からは決めない。
 * `baseUrl`は`BASE_INTERNAL_URL`を優先し、無ければ`BASE_URL`を使う。
 * workerのジョブ内で実測すると`BASE_INTERNAL_URL`は未設定で、
 * `BASE_URL`には`http://127.0.0.1:45753/`(worker内のプロキシのポート)が
 * 入っていた。ホスト側の開発用に`mise.toml`が設定する`WM_BASE_URL`とは別物で、
 * 実際のworkerの実行で`wmill datatable migrate up`がこれを通して成功した。
 * どちらかが決まらなければ例外を投げる。
 * 2段下の`wmill` CLIが"no workspace"や"could not authenticate"という
 * 分かりにくいエラーで失敗するより、ここで明確なメッセージで失敗させる。
 */
export function resolveWmillCliContext(
  env: WmillCliContextInput,
): WmillCliContext {
  const baseUrl = env.BASE_INTERNAL_URL ?? env.BASE_URL;
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new Error(
      "self_update: cannot resolve a base URL for the wmill CLI (BASE_INTERNAL_URL and BASE_URL are both unset)",
    );
  }
  const workspace = env.WM_WORKSPACE;
  if (workspace === undefined || workspace.length === 0) {
    throw new Error(
      "self_update: cannot resolve a workspace for the wmill CLI (WM_WORKSPACE is unset)",
    );
  }
  return { workspace, baseUrl };
}

/**
 * 空の設定ディレクトリから`wmill`を対話なしで動かすのに必要な
 * `--workspace <ws> --base-url <url> --token <token>`を`baseArgv`に足す
 * (実測の結果はこの節の冒頭コメントを参照)。
 * `token`は呼び出し側が別に取得した秘密情報を必ず引数で受け取り、
 * `context`からは読まない。フィールドの欠落や名前の誤りで
 * うっかり抜け落ちることを防ぐためである。
 */
export function buildWmillArgv(
  baseArgv: readonly string[],
  context: WmillCliContext,
  token: string,
): string[] {
  return [
    ...baseArgv,
    "--workspace",
    context.workspace,
    "--base-url",
    context.baseUrl,
    "--token",
    token,
  ];
}

// ---------------------------------------------------------------------------
// buildWmillEnv: worker内の`wmill` CLIのサブプロセスに渡す最小限の環境変数
// ---------------------------------------------------------------------------

export type WmillEnvInput = {
  readonly HOME?: string | undefined;
  readonly PATH?: string | undefined;
};

/**
 * `wmill sync push` / `wmill datatable migrate up`のサブプロセスに渡す
 * 最小限の環境変数を作る。
 * 入れるのは`HOME`(CLIの設定ディレクトリ用)と`PATH`(`wmill`本体を探す用)、
 * それに`NPM_CONFIG_IGNORE_SCRIPTS`である。`process.env`全体は渡さず、
 * workerのプロセスがたまたま持つほかの値がサブプロセスに漏れないようにする。
 * `NPM_CONFIG_IGNORE_SCRIPTS`は、`wmill sync push`がraw appのバンドルで
 * 走らせるnpmにも、依存のinstall scriptを動かさせないためのものである
 * (`npm ci`の`--ignore-scripts`はそのバンドルには効かない)。
 * workspace・base-url・tokenは意図して環境変数にしない。
 * このCLIはそれらを環境変数から読まないことを実測で確かめている
 * (この節の前にある、wmill CLIの接続の節の冒頭コメントを参照)。
 */
export function buildWmillEnv(env: WmillEnvInput): Record<string, string> {
  const result: Record<string, string> = { NPM_CONFIG_IGNORE_SCRIPTS: "true" };
  if (env.HOME !== undefined) result.HOME = env.HOME;
  if (env.PATH !== undefined) result.PATH = env.PATH;
  return result;
}

// ---------------------------------------------------------------------------
// truncateOutput: ログに出す前にサブプロセスの出力を切り詰める
// ---------------------------------------------------------------------------

/**
 * `text`を最大`max`文字に切り詰める。
 * `maskSecrets`でマスク済みのサブプロセスの出力をログに出すとき、
 * ジョブログが際限なく大きくならないようにする。
 */
export function truncateOutput(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

// ---------------------------------------------------------------------------
// raw appの依存: `wmill sync push`はConsoleのraw appをその場でバンドルし、
// importをself clone内の`node_modules`から解決する。
// ---------------------------------------------------------------------------

/**
 * Consoleのraw appのディレクトリ(リポジトリからの相対パス)。
 * `wmill sync push`でバンドルする前に、npmの依存を入れておく必要がある。
 */
export const RAW_APP_RELATIVE_DIR = "f/factory/factory_console__raw_app";

/**
 * raw appに対する`npm ci`の引数を返す。
 * `npm ci`は`package-lock.json`が固定するものをそのまま入れ、ファイルを
 * 書き換えない。self clone内で`npm install`を使うと`package-lock.json`が
 * 書き換わったまま残り、次の`git checkout -B`を妨げたことがある。
 * `--no-audit --no-fund`は出力を減らし、オフラインでも動きやすくする。
 * `--ignore-scripts`は依存のinstall scriptを動かさない。install scriptは
 * workerの権限のまま、ネットワークにも出られる状態で動くため。
 * raw appの依存にinstall scriptを要するものは無く(`package-lock.json`に
 * `hasInstallScript`が無い)、バンドルは`wmill`が行うので、組み立ては変わらない。
 */
export function buildNpmCiArgv(rawAppDir: string): string[] {
  return [
    "npm",
    "ci",
    "--prefix",
    rawAppDir,
    "--no-audit",
    "--no-fund",
    "--ignore-scripts",
  ];
}

/**
 * `self_update`が、上限を持たないSDKとDBの呼び出し(変数の取得と更新、stateの読み書き、
 * DBへの記録、Discordへの通知)1回に許す時間(ミリ秒)。
 * ジョブ全体の`timeout`は、子プロセスの実行中に当たると子が残りうる最後の砦なので、
 * 通常はこの上限で先に終わらせる。
 */
export const SELF_UPDATE_CALL_TIMEOUT_MS = 30_000;

/**
 * `work`が`timeoutMs`以内に終わらなければ、例外を投げる。
 * `work`自体は中断しないので、副作用が後から完了することはありうる。
 * `label`は例外の文に入る。秘密値を含めてはならない。
 */
export async function withCallTimeout<T>(
  label: string,
  work: () => Promise<T>,
  timeoutMs: number = SELF_UPDATE_CALL_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(), expired]);
  } finally {
    clearTimeout(timer);
  }
}
