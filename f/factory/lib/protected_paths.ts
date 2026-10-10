// 保護パスの判定を、pr_fixとimplementフローで共有する。
// pr_fix(`steps/pr_workflow_support.ts`)では一致するとpushを止め
// (docs/security.md「PR修正の安全策」)、implementフロー(`lib/implement_support.ts`)では
// PR本文とDiscord通知に記録するだけにする。
// `implement_support`が`steps`からimportしないで済むよう`lib`に置き、
// `pr_workflow_support.ts`が判定関数とpr_fixの一覧を再exportする。

export type ChangedPathStatus =
  | "added"
  | "modified"
  | "deleted"
  | "typechange"
  | "unknown";

export type ChangedPath = {
  readonly path: string;
  readonly status: ChangedPathStatus;
};

/**
 * pr_fixが保護するディレクトリ。
 * どのコマンドが実行されるか、パッケージマネージャーやgitが何を信頼するかを変える設定を
 * すべて含める(エージェントの設定、CIのワークフロー、
 * miseのXDG・ドットファイルの設定場所、
 * ディレクトリ形式のlefthook設定)。
 * `console/public/`も含める。Consoleでバンドルを通らずにそのまま配信され、ページの中で動くファイルを置く。
 * `infra/console_fetcher/`も含める。Consoleの配信物を検証して配信するコードで、書き換えられると、
 * 検証をすり抜けた内容が運用者のブラウザに配信される。
 */
export const FORBIDDEN_PATH_PREFIXES: readonly string[] = [
  ".claude/",
  ".agents/",
  ".github/workflows/",
  ".mise/",
  ".config/mise/",
  ".lefthook/",
  "console/public/",
  "infra/console_fetcher/",
];

/**
 * pr_fixが保護する個別のファイル(リポジトリのルートからの相対パス)。
 * `console/index.html`は、Consoleのすべてのscriptの読み込み元で、バンドルを通らずに配信される。
 * ファイル名だけでは他の`index.html`と区別できないので、パスで判定する。
 * `console/drawio-viewer.json`は、CIが取得して配信するdraw.ioのビューアの取得元とsha256を固定する。
 * 書き換えられると、別のスクリプトを固定の値として配信される。
 * 固定を強制する側も同じ理由で守る。ビューアの照合と取得、配信物の一覧(manifest.json)の作成、
 * lockfileの検査のスクリプトは、書き換えられると検査をすり抜けて配信物に混ざる。
 * `asset-name.ts`は照合したビューアの書き込み先の名前を決め、`vite.config.ts`は
 * 組み立ての途中で任意のコードを動かして配信物に書ける。
 * `infra/Caddyfile`には、Consoleのscriptの許可と、draw.ioの図を隔離するCSPがある。
 * `infra/`全体は、pr_fixでは止めない。
 * 旧Consoleのraw appが図を隔離して描く部品も守る。iframeを作る`DrawioViewer.tsx`、
 * iframeの`src`とsandboxの定数(`drawioMessages.ts`)と、それらを固定値と照合するテストである。
 * 書き換えられると、図を描くiframeにsandboxを外したり別のページを読ませたりできる。
 */
export const FORBIDDEN_EXACT_PATHS: readonly string[] = [
  "console/index.html",
  "console/drawio-viewer.json",
  "console/scripts/drawio-viewer.ts",
  "console/scripts/fetch-drawio-viewer.ts",
  "console/scripts/manifest.ts",
  "console/scripts/write-manifest.ts",
  "scripts/check-console-lockfile.ts",
  "console/scripts/asset-name.ts",
  "console/vite.config.ts",
  "infra/Caddyfile",
  "f/factory/factory_console__raw_app/components/DrawioViewer.tsx",
  "f/factory/factory_console__raw_app/lib/drawioMessages.ts",
  "tests/lib/drawio_raw_app_isolation.test.ts",
];

/**
 * pr_fixが保護するファイル名(ディレクトリを問わない)。
 * markdownlint-cli2とtextlintの設定も含める。どちらも設定から任意のモジュールを読み込めて、
 * pre-commitと`mise run check`が読むので、書き換えられるとコードを実行されるため。
 */
export const FORBIDDEN_BASENAME_PATTERNS: readonly RegExp[] = [
  /^mise\.toml$/,
  /^mise\..*\.toml$/,
  /^\.mise\.toml$/,
  /^lefthook\.yml$/,
  /^lefthook-local\.yml$/,
  /^lefthook\.toml$/,
  /^lefthook\.json$/,
  /^bunfig\.toml$/,
  /^\.npmrc$/,
  /^\.gitattributes$/,
  /^\.gitmodules$/,
  /^\.markdownlint(-cli2)?\.(jsonc?|ya?ml|[cm]?js)$/,
  /^\.textlintrc(\..*)?$/,
];

/**
 * implementフローが保護するディレクトリで、pr_fixの一覧に次を加えたもの。
 * - pr_fixの一覧の`.github/workflows/`を、`.github/`全体(actions、dependabot、CODEOWNERS)に広げる。
 * - `infra/**`: workerのイメージとcomposeの定義。変更は次にホスト側で
 *   `mise run up`するまで反映されないため、レビューする人が知る必要がある。
 * - gitフックのディレクトリ(`.husky/`、`.githooks/`)
 * - `.yarn/`: パッケージマネージャーが実行するプラグインとリリース
 * - `.devcontainer/`
 *
 * implementフローはClaudeの変更に対して検査コマンドを実行するため、
 * 検査コマンドが何を実行するかを決めるディレクトリを保護する。pr_fixの一覧は変えない。
 */
export const IMPLEMENT_PROTECTED_PATH_PREFIXES: readonly string[] = [
  ...FORBIDDEN_PATH_PREFIXES.map((prefix) =>
    prefix === ".github/workflows/" ? ".github/" : prefix,
  ),
  "infra/",
  ".husky/",
  ".githooks/",
  ".yarn/",
  ".devcontainer/",
];

/** implementフローが保護する個別のファイル。pr_fixの一覧と同じ。 */
export const IMPLEMENT_PROTECTED_EXACT_PATHS: readonly string[] = [
  ...FORBIDDEN_EXACT_PATHS,
];

/**
 * implementフローが保護するファイル名。
 * pr_fixのリストに、検査コマンドが何を実行し何を信頼するかを決めるファイルをすべて加える
 * (envファイル、gitleaksの設定、ランタイム・ツールチェーンのバージョン指定、
 * パッケージマネージャーの設定とロックファイル、ツールの設定モジュールとrcファイル、
 * タスクランナー、`scripts`に限らず`package.json`全体)。
 */
export const IMPLEMENT_PROTECTED_BASENAME_PATTERNS: readonly RegExp[] = [
  ...FORBIDDEN_BASENAME_PATTERNS,
  /^\.env(\..*)?$/,
  /^\.gitleaks(ignore|\.toml)$/,
  /^\.tool-versions$/,
  /^\.(node|bun|python)-version$/,
  /^\.nvmrc$/,
  /^rust-toolchain(\.toml)?$/,
  /^\.yarnrc(\.yml)?$/,
  /^\.pnpmfile\.cjs$/,
  /^(bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/,
  /^[\w.-]+\.config\.[cm]?[jt]s$/,
  /^\.(eslintrc|babelrc|prettierrc)(\..*)?$/,
  /^(Makefile|[Jj]ustfile|Taskfile\.ya?ml|turbo\.json|nx\.json|deno\.jsonc?|CODEOWNERS|\.pre-commit-config\.yaml)$/,
  /^package\.json$/,
  // JS以外のロックファイルとマニフェスト。インストール時に、記載された
  // ビルドスクリプトや`setup.py`が実行され、固定したものが取得される。
  /^(uv|poetry)\.lock$/,
  /^Pipfile(\.lock)?$/,
  /^pyproject\.toml$/,
  /^setup\.(py|cfg)$/,
  /^requirements.*\.txt$/,
  /^Cargo\.(lock|toml)$/,
  /^go\.(sum|mod)$/,
  /^Gemfile(\.lock)?$/,
  /^composer\.(lock|json)$/,
];

function matchesPathLists(
  path: string,
  prefixes: readonly string[],
  basenamePatterns: readonly RegExp[],
): boolean {
  const normalized = path.replace(/^\.\//, "");
  for (const prefix of prefixes) {
    if (normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)) {
      return true;
    }
  }
  const basename = normalized.split("/").pop() ?? normalized;
  return basenamePatterns.some((pattern) => pattern.test(basename));
}

/**
 * `path`がdocs/security.md「PR修正の安全策」の禁止パスに当たるかを返す。
 * `prefixes`のディレクトリは、リポジトリのルートからの相対パスの前方一致で判定する
 * (ディレクトリ名そのものも一致とみなす)。
 * `FORBIDDEN_EXACT_PATHS`とは完全一致で、`FORBIDDEN_BASENAME_PATTERNS`は
 * ディレクトリを問わずファイル名で判定する。
 * `prefixes`の既定はpr_fixのリスト。
 */
export function matchesForbiddenPath(
  path: string,
  prefixes: readonly string[] = FORBIDDEN_PATH_PREFIXES,
): boolean {
  const normalized = path.replace(/^\.\//, "");
  if (FORBIDDEN_EXACT_PATHS.includes(normalized)) return true;
  return matchesPathLists(path, prefixes, FORBIDDEN_BASENAME_PATTERNS);
}

/**
 * `path`がimplementフローの保護パスに当たるかを返す。
 * 判定の規則は`matchesForbiddenPath`と同じで、リストに
 * `IMPLEMENT_PROTECTED_PATH_PREFIXES`と`IMPLEMENT_PROTECTED_BASENAME_PATTERNS`を使う。
 * `IMPLEMENT_PROTECTED_EXACT_PATHS`とは完全一致で判定する。
 */
export function matchesImplementProtectedPath(path: string): boolean {
  const normalized = path.replace(/^\.\//, "");
  if (IMPLEMENT_PROTECTED_EXACT_PATHS.includes(normalized)) return true;
  return matchesPathLists(
    path,
    IMPLEMENT_PROTECTED_PATH_PREFIXES,
    IMPLEMENT_PROTECTED_BASENAME_PATTERNS,
  );
}

export function isNewShellScript(entry: ChangedPath): boolean {
  return entry.status === "added" && /\.sh$/i.test(entry.path);
}
