// 保護パスの判定を、pr_fixとimplementフローで共有する。
// pr_fix(`steps/pr_workflow_support.ts`)では一致するとpushを止め
// (docs/security.md「pr_fixの安全策」)、implementフロー(`lib/implement_support.ts`)では
// PR本文とDiscord通知に記録するだけにする。
// `implement_support`が`steps`からimportしないで済むよう`lib`に置き、
// `pr_workflow_support.ts`がここの定義をすべて再exportする。

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
 */
export const FORBIDDEN_PATH_PREFIXES: readonly string[] = [
  ".claude/",
  ".agents/",
  ".github/workflows/",
  ".mise/",
  ".config/mise/",
  ".lefthook/",
];

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
];

/**
 * implementフローが保護するディレクトリで、pr_fixの一覧に次を加えたもの。
 * - pr_fixの一覧の`.github/workflows/`を、`.github/`全体(actions、dependabot、CODEOWNERS)に広げる。
 * - `infra/**`: workerのイメージとcomposeの定義。変更するとホスト側で`mise run deploy`が
 *   要るため、レビューする人が知る必要がある。
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
 * `path`がdocs/security.md「pr_fixの安全策」の禁止パスに当たるかを返す。
 * `prefixes`のディレクトリは、リポジトリのルートからの相対パスの前方一致で判定する
 * (ディレクトリ名そのものも一致とみなす)。
 * `FORBIDDEN_BASENAME_PATTERNS`は、ディレクトリを問わずファイル名で判定する。
 * `prefixes`の既定はpr_fixのリスト。
 */
export function matchesForbiddenPath(
  path: string,
  prefixes: readonly string[] = FORBIDDEN_PATH_PREFIXES,
): boolean {
  return matchesPathLists(path, prefixes, FORBIDDEN_BASENAME_PATTERNS);
}

/**
 * `path`がimplementフローの保護パスに当たるかを返す。
 * 判定の規則は`matchesForbiddenPath`と同じで、リストに
 * `IMPLEMENT_PROTECTED_PATH_PREFIXES`と`IMPLEMENT_PROTECTED_BASENAME_PATTERNS`を使う。
 */
export function matchesImplementProtectedPath(path: string): boolean {
  return matchesPathLists(
    path,
    IMPLEMENT_PROTECTED_PATH_PREFIXES,
    IMPLEMENT_PROTECTED_BASENAME_PATTERNS,
  );
}

export function isNewShellScript(entry: ChangedPath): boolean {
  return entry.status === "added" && /\.sh$/i.test(entry.path);
}
