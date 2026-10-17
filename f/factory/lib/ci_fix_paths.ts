// CI回でClaudeが変えてよいファイルを、許可リスト方式で検査する純関数。
// 入力は、Claudeが加えた変更の一覧(パス、種別、追加した行)と、PRがすでに変更したファイルのパスである。
// gitの呼び出しは含まない。入力を作る側が、検査の対象にした差分から作る。
// 許可するのは「PRがすでに変更したファイル」と「新規に追加するテストファイル」だけで、
// 保護パスとFactoryの安全装置は常に拒否する。
// 検査を弱める変更(警告の抑制、テストの無効化)も拒否する。
// 検査は拒否に倒す。パスの綴りの違い(大文字小文字、Unicodeの正規化)で許可リストをすり抜けさせない。

import { cleanLogText } from "./ci_log_support.ts";
import {
  type ChangedPathStatus,
  FORBIDDEN_EXACT_PATHS,
  IMPLEMENT_PROTECTED_BASENAME_PATTERNS,
  IMPLEMENT_PROTECTED_EXACT_PATHS,
  IMPLEMENT_PROTECTED_PATH_PREFIXES,
} from "./protected_paths.ts";

/**
 * Claudeが加えた変更1件。
 * gitのrename検出は切り、移動は削除と追加の2件で渡す。
 * rename検出を使うと、移動元の削除が見えなくなるため。
 */
export type CiFixChange = {
  /** リポジトリのルートからの相対パス。 */
  readonly path: string;
  readonly status: ChangedPathStatus;
  /**
   * gitのモード(`100644`、`100755`、`120000`、`160000`など)。変更後のモードで、削除では変更前のモード。
   * 通常のファイル(`100644`と`100755`)以外は拒否する。
   * シンボリックリンクの真偽値は別に持たない。モードが唯一の情報源なら、食い違う入力が起きない。
   */
  readonly mode: string;
  /** 変更後に追加された行(先頭の`+`は除く)。バイナリなら空。 */
  readonly addedLines: readonly string[];
  /** 削除された行の数。 */
  readonly removedLineCount: number;
};

export type CiFixPathInput = {
  readonly changes: readonly CiFixChange[];
  /** PRがすでに変更したファイルのパス。許可リストの1つ目。 */
  readonly prChangedPaths: readonly string[];
};

/**
 * 違反の理由。
 * - `unsafe_path`: 絶対パス、`..`、制御文字や不可視文字、Unicodeの正規化が異なる綴りなど。
 * - `symlink`: シンボリックリンク(モード`120000`)、または種別の変更。
 * - `unsupported_change`: 種別を判定できない、または通常のファイル以外のモード(サブモジュールなど)。
 * - `protected_path`: 保護パスかFactoryの安全装置。
 * - `case_variant_path`: PRが変更したファイルと大文字小文字だけが違うパス。
 * - `not_in_pull_request`: PRが変更しておらず、新規のテストファイルでもない。
 * - `test_not_additive`: テストの削除、または既存のテスト行の削除や変更。
 * - `weakens_checks`: 検査を弱める行を追加した。
 */
export type CiFixViolationCode =
  | "unsafe_path"
  | "symlink"
  | "unsupported_change"
  | "protected_path"
  | "case_variant_path"
  | "not_in_pull_request"
  | "test_not_additive"
  | "weakens_checks";

export type CiFixViolation = {
  readonly code: CiFixViolationCode;
  /** 表示してよい形に直したパス。 */
  readonly path: string;
};

export type CiFixPathVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly CiFixViolation[] };

// ---------------------------------------------------------------------------
// パスの形
// ---------------------------------------------------------------------------

const PATH_MAX_CHARS = 1024;
const DISPLAY_PATH_MAX_CHARS = 120;

/** パスに含めてはいけない文字。普通の空白は許し、それ以外の空白と制御・書式・不可視の文字を拒む。 */
const UNSAFE_PATH_CHARS = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]|(?! )\p{Zs}/u;

/**
 * リポジトリの中の相対パスとして、そのまま信頼してよい形か。
 * 絶対パス、ドライブ名、`.`と`..`と空のセグメント、末尾のスラッシュ、バックスラッシュ、
 * `.git`のセグメント(大文字小文字を問わない)、制御文字と不可視文字を拒む。
 * NFKCに正規化しても変わらない綴りだけを許す。互換文字や分解した文字で、
 * 保護パスの照合をすり抜けさせないため。
 */
export function isSafeRepoPath(path: string): boolean {
  if (path === "" || path.length > PATH_MAX_CHARS) return false;
  if (UNSAFE_PATH_CHARS.test(path)) return false;
  if (path.includes("\\") || path.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  if (path.normalize("NFKC") !== path) return false;
  return path
    .split("/")
    .every(
      (segment) =>
        segment !== "" &&
        segment !== "." &&
        segment !== ".." &&
        segment.toLowerCase() !== ".git",
    );
}

/** 違反の報告に載せるパス。外部由来なので、不可視文字を除き、空白を詰めて切る。 */
export function displayPath(path: string): string {
  const flat = cleanLogText(path).replace(/\s+/g, " ").trim();
  return Array.from(flat).slice(0, DISPLAY_PATH_MAX_CHARS).join("");
}

// ---------------------------------------------------------------------------
// 保護パス
// ---------------------------------------------------------------------------

/**
 * CI回で常に拒否するディレクトリの前方一致(小文字)。
 * `.claude/`と`.agents/`は実行するコマンドと指示を決める。`.github/`はCIの定義である。
 * `console/src/`と`scripts/`は検査とConsoleの配信物を作る。`migrations/`はDBを変える。
 * `infra/`などの実装フローの保護パスは別に拒否する。
 */
const CI_DENIED_DIRECTORIES: readonly string[] = [
  ".claude/",
  ".agents/",
  ".github/",
  "console/src/",
  "scripts/",
  "migrations/",
];

/**
 * CI回で常に拒否するFactoryの安全装置の名前の前方一致(小文字)。
 * 拡張子の違うファイル(`.ts`、`.script.yaml`、`.script.lock`)をまとめて拒否するため、
 * ステムで終わらせる。
 * Claudeの実行、保護パスの判定、ログの機密保持、作業ディレクトリ、検査の隔離、pr_fixのstep、
 * CI回のログの整形・検査・分類・プロンプト・パスの検査、PRとmainのCIの判定と起動、
 * 競合の検知と競合を直す回の判断・プロンプト(`pr_conflict_`と`conflict_fix_`で始まる部品)、pr_fixフローの起動(`pr_fix_launch`)、
 * プロンプトの組み立て(`prompts`)、検査コマンドの実行(`check_runner`)、GitHubの読み書き(`github`)、
 * メタデータのパッチの検査と`wmill-lock.yaml`のhashの再計算(`metadata_`で始まる部品)、
 * GitHubの収集(宛先を固定したGraphQLの通信の`gh_graphql`、照合と`gone`の判定の`gh_collect`で始まる部品、それを呼ぶ`collect_github`)、
 * 自動で再開してよい止まった理由の一覧(`auto_retry_reasons`)、
 * 検査の前提が古いときの理由(`check_sandbox_reasons`)、GitHubの呼び出しの失敗の型(`github_errors`)である。
 * 一覧は、CI回と競合回の回復が「待たずに保留なしで外す回」を決め、競合回の数え方が「数えない回」を決める。
 * 広い接頭辞を足されると、競合回の上限が効かなくなる。
 */
const CI_DENIED_NAME_PREFIXES: readonly string[] = [
  "f/factory/lib/claude.",
  "f/factory/lib/protected_paths.",
  "f/factory/lib/log.",
  "f/factory/lib/workspace.",
  "f/factory/lib/check_sandbox.",
  "f/factory/lib/check_runner.",
  "f/factory/lib/prompts.",
  "f/factory/lib/github.",
  "f/factory/lib/types.",
  "f/factory/lib/job_tmp.",
  "f/factory/lib/check_sandbox_reasons.",
  "f/factory/lib/github_errors.",
  "f/factory/lib/gh_graphql.",
  "f/factory/lib/gh_collect",
  "f/factory/lib/repo_owner_gate.",
  "f/factory/lib/model_policy.",
  "f/factory/lib/config.",
  "f/factory/lib/host_action.",
  "f/factory/lib/process_lock.",
  "f/factory/lib/factory_repo_gate.",
  "f/factory/lib/auto_retry_reasons.",
  "f/factory/lib/ci_",
  "f/factory/lib/pr_ci_",
  "f/factory/lib/pr_conflict_",
  "f/factory/lib/conflict_fix_",
  "f/factory/lib/pr_fix_launch.",
  "f/factory/lib/main_ci_",
  "f/factory/lib/metadata_",
  "f/factory/watch_pr_ci.",
  "f/factory/watch_pr_conflicts.",
  "f/factory/watch_main_ci.",
  "f/factory/collect_github.",
  "f/factory/steps/pr_fix_",
  "f/factory/steps/pr_workflow_support.",
];

/** CI回で常に拒否する、パス全体の形(小文字)。Windmillのflowの定義。 */
const CI_DENIED_PATH_PATTERNS: readonly RegExp[] = [/(?:^|\/)[^/]*__flow\//];

/** CI回で常に拒否するファイル名(ディレクトリを問わない、小文字)。 */
const CI_DENIED_BASENAME_PATTERNS: readonly RegExp[] = [
  /^tsconfig[\w.-]*\.json$/,
  /^biome\.jsonc?$/,
  /^wmill(-lock)?\.yaml$/,
  /\.script\.lock$/,
  /\.(?:schedule|variable|resource|resource-type|trigger)\.yaml$/,
  /^\.mcp\.json$/,
  // 無視ファイル。入れ子の`.gitignore`などは、biomeやprettierの対象から
  // 既存のファイルを外せる。`tests/`の配下の新規ファイルとして許可リストを通さないため、
  // テストの判定より前に拒否する。
  /^\.[\w.-]*ignore$/,
  /^\.editorconfig$/,
  // テストの収集と実行を変えるファイル。`tests/`の配下に置いても効くので、同じ理由で先に拒否する。
  // `*.config.*`や`pyproject.toml`などは、実装フローの保護ファイル名がすでに拒否する。
  /^conftest\.py$/,
  /^(?:pytest|tox)\.ini$/,
  /^\.(?:mocharc|nycrc|c8rc|coveragerc)(?:\..*)?$/,
  /^(?:vitest|jest)\.setup\.[\w.-]+$/,
];

/** 実装フローの保護ファイル名を、大文字小文字を問わない形にしたもの。 */
const IMPLEMENT_BASENAME_PATTERNS_CI: readonly RegExp[] =
  IMPLEMENT_PROTECTED_BASENAME_PATTERNS.map(
    (pattern) =>
      new RegExp(
        pattern.source,
        pattern.flags.includes("i") ? pattern.flags : `${pattern.flags}i`,
      ),
  );

const PROTECTED_EXACT_LOWERCASE: ReadonlySet<string> = new Set(
  [...IMPLEMENT_PROTECTED_EXACT_PATHS, ...FORBIDDEN_EXACT_PATHS].map((path) =>
    path.toLowerCase(),
  ),
);

/** `directory`(末尾が`/`)の配下か、`directory`そのものか。 */
function inDirectory(lowerPath: string, directory: string): boolean {
  return (
    lowerPath === directory.slice(0, -1) || lowerPath.startsWith(directory)
  );
}

/**
 * パスが、CI回で常に拒否するものか。大文字小文字を区別せずに判定する。
 * 実装フローの保護パス(`IMPLEMENT_PROTECTED_*`)に、CI回だけの拒否を足したもの。
 * 大文字小文字を畳むのは、大文字小文字を区別しないファイルシステムで同じファイルを指す綴りを拒否するため。
 */
export function isDeniedPath(path: string): boolean {
  const lower = path.toLowerCase();
  if (PROTECTED_EXACT_LOWERCASE.has(lower)) return true;
  const directories = [
    ...IMPLEMENT_PROTECTED_PATH_PREFIXES.map((prefix) => prefix.toLowerCase()),
    ...CI_DENIED_DIRECTORIES,
  ];
  if (directories.some((directory) => inDirectory(lower, directory))) {
    return true;
  }
  if (CI_DENIED_NAME_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return true;
  }
  if (CI_DENIED_PATH_PATTERNS.some((pattern) => pattern.test(lower))) {
    return true;
  }
  const basename = lower.split("/").pop() ?? lower;
  return (
    CI_DENIED_BASENAME_PATTERNS.some((pattern) => pattern.test(basename)) ||
    IMPLEMENT_BASENAME_PATTERNS_CI.some((pattern) => pattern.test(basename))
  );
}

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

/** テストのディレクトリ、またはテストのファイル名(`*.test.ts`、`*.spec.tsx`など)か。 */
export function isTestPath(path: string): boolean {
  const lower = path.toLowerCase();
  const segments = lower.split("/");
  if (
    segments.some(
      (segment) =>
        segment === "tests" || segment === "test" || segment === "__tests__",
    )
  ) {
    return true;
  }
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(lower);
}

// ---------------------------------------------------------------------------
// 検査を弱める行
// ---------------------------------------------------------------------------

/**
 * 追加行に入ると検査を弱める記述。大文字小文字を区別しない。
 * 警告やエラーの抑制、型検査の無効化、テストの除外と保留、テスト実行の中断、モジュールの差し替え、
 * カバレッジの除外、秘密値の検査の許可である。
 * 追加行を1行ずつ見る照合なので、囲みによる無効化(`if (false)`や、コメントアウトした行)は検出しない。
 */
const WEAKENING_PATTERNS: readonly RegExp[] = [
  /biome-ignore/i,
  /@ts-(?:ignore|expect-error|nocheck)/i,
  /eslint-disable/i,
  /tslint:disable/i,
  // `.skip`、`.only`、`.todo`、`.failing`は、呼び出しの括弧を要求しない。
  // `test.skip.each(...)`や、変数に取り出した`const t = describe.skip`も除外にあたるため。
  /\.\s*(?:skip|only|todo|failing)\b/i,
  /\.\s*(?:if|runIf|skipIf|todoIf)\s*\(/i,
  // `test["skip"]`などの括弧記法。
  /\[\s*["'`](?:skip|only|todo|failing|if|runIf|skipIf|todoIf)["'`]\s*\]/i,
  /\bskip\s*:\s*true\b/i,
  /\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(/i,
  /\bprocess\s*\.\s*exit\s*\(/i,
  /\bmock\s*\.\s*module\s*\(/i,
  /istanbul\s+ignore/i,
  /\bc8\s+ignore/i,
  /\bv8\s+ignore/i,
  /#\s*noqa\b/i,
  /#\s*type:\s*ignore/i,
  /pragma:\s*no\s+cover/i,
  /\bnolint\b/i,
  /\bnosonar\b/i,
  /gitleaks:allow/i,
  // 文書の検査の抑制。markdownlintとtextlintのコメント。
  /markdownlint-(?:disable|capture|configure-file)/i,
  /textlint-disable/i,
  // テストの振る舞いの差し替え。既存のテストの意味を変えずに足せる書き方は少ない。
  /\bspyOn\s*\(/i,
  /\b(?:vi|jest)\s*\.\s*mock\s*\(/i,
  /\.\s*mock(?:Implementation|ReturnValue|ResolvedValue|RejectedValue)/i,
];

/**
 * `lines`のどれかが、検査を弱める記述(`WEAKENING_PATTERNS`)に当たるか。
 * CI回の追加行と、競合回の解消で新しく足した行の検査が使う。
 */
export function weakensChecks(lines: readonly string[]): boolean {
  return lines.some((line) =>
    WEAKENING_PATTERNS.some((pattern) => pattern.test(line)),
  );
}

// ---------------------------------------------------------------------------
// 検査
// ---------------------------------------------------------------------------

const SYMLINK_MODE = "120000";
/** 通常のファイルのモード。実行権限の有無だけが違う。 */
const REGULAR_FILE_MODES: readonly string[] = ["100644", "100755"];

/** 1件の変更の最初の違反の理由。違反が無ければnull。 */
function violationOf(
  change: CiFixChange,
  prPaths: ReadonlySet<string>,
  prPathsLowercase: ReadonlySet<string>,
): CiFixViolationCode | null {
  const { path } = change;
  if (!isSafeRepoPath(path)) return "unsafe_path";
  if (change.mode === SYMLINK_MODE || change.status === "typechange") {
    return "symlink";
  }
  if (change.status === "unknown") return "unsupported_change";
  if (!REGULAR_FILE_MODES.includes(change.mode)) return "unsupported_change";
  if (isDeniedPath(path)) return "protected_path";

  const changedByPr = prPaths.has(path);
  if (!changedByPr && prPathsLowercase.has(path.toLowerCase())) {
    return "case_variant_path";
  }
  const newTest = change.status === "added" && isTestPath(path);
  if (!changedByPr && !newTest) return "not_in_pull_request";

  if (isTestPath(path)) {
    const removesTestLines =
      change.status === "deleted" || change.removedLineCount > 0;
    if (removesTestLines) return "test_not_additive";
  }
  if (weakensChecks(change.addedLines)) return "weakens_checks";
  return null;
}

/**
 * CI回でClaudeが加えた変更が、許可リストの範囲に収まるかを検査する。
 * 変更ごとに、次の順で最初に当たる違反を1件ずつ返す。
 * パスの形、シンボリックリンク、保護パス、許可リスト(PRが変更したファイルか新規のテスト)、
 * テストの追加だけの規則、検査を弱める行。
 * 1件でも違反があれば`ok: false`にし、呼び出し側はpushせず人に渡す。
 */
export function checkCiFixChanges(input: CiFixPathInput): CiFixPathVerdict {
  const prPaths = new Set(input.prChangedPaths);
  const prPathsLowercase = new Set(
    input.prChangedPaths.map((path) => path.toLowerCase()),
  );
  const violations: CiFixViolation[] = [];
  for (const change of input.changes) {
    const code = violationOf(change, prPaths, prPathsLowercase);
    if (code !== null)
      violations.push({ code, path: displayPath(change.path) });
  }
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}
