/** 実行役が判定に使う定数。閾値、外部コマンドの上限、必須チェックの名前をここに集める。 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * 目標のコミットで通っているべきチェックの名前。mainのrulesetの必須チェックと同じ。
 * 名前が変わると、チェックが欠けた扱いで保留になる。安全側に倒れ、24時間後に気づける。
 */
export const REQUIRED_CHECKS: readonly string[] = [
  "scope",
  "check",
  "test-db",
  "metadata",
  "console",
  "caddyfile",
  "console-fetcher-image",
];

/** 必須チェックを出すworkflowのパス。同名のチェックを別のworkflowが出しても数えない。 */
export const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";

/**
 * composeが参照する、`mise.toml`の`[env]`のキー。
 * 実行役はこのキーの値だけを静的に取り出して、composeに渡す。
 */
export const MISE_ENV_KEYS: readonly string[] = [
  "WM_VERSION",
  "WM_HTTP_PORT",
  "WM_BIND",
  "WM_SESSION_VALIDITY_SECONDS",
  "CONSOLE_GITHUB_REPO",
  "CLAUDE_VERSION",
  "GH_VERSION",
  "GITLEAKS_VERSION",
  "GTR_REF",
  "GTR_COMMIT",
  "WMILL_VERSION",
  "FACTORY_CHECK_UID",
  "FACTORY_CHECK_POOL_SIZE",
  "LOG_MAX_SIZE",
  "LOG_MAX_FILE",
];

export type CommandKind =
  | "git_read"
  | "git_fetch"
  | "git_worktree_add"
  | "docker_inspect"
  | "docker_ps"
  | "docker_volume_ls"
  | "launchctl"
  | "compose_dry_run"
  | "compose_pull"
  | "compose_build"
  | "compose_up"
  | "host_script"
  | "http_fetch"
  | "host_probe";

export const COMMAND_KINDS: readonly CommandKind[] = [
  "git_read",
  "git_fetch",
  "git_worktree_add",
  "docker_inspect",
  "docker_ps",
  "docker_volume_ls",
  "launchctl",
  "compose_dry_run",
  "compose_pull",
  "compose_build",
  "compose_up",
  "host_script",
  "http_fetch",
  "host_probe",
];

/**
 * 外部コマンドの種類ごとの上限(ミリ秒)。超えたコマンドは失敗として扱う。
 * macOSの標準に`timeout`コマンドが無いので、bunの子プロセスの時間切れで止める。
 * `git_read`は`plan`と`approve`が使う読み取りのgit。ローカルのオブジェクトだけを読むので短くする。
 * `host_probe`は`ps`と`sysctl`の照会で、ホストの状態を読むだけなので短くする。
 */
export const COMMAND_TIMEOUT_MS: Readonly<Record<CommandKind, number>> = {
  git_read: 30_000,
  git_fetch: 2 * MINUTE,
  git_worktree_add: 2 * MINUTE,
  docker_inspect: 30_000,
  docker_ps: 30_000,
  docker_volume_ls: 30_000,
  launchctl: 30_000,
  compose_dry_run: MINUTE,
  compose_pull: 20 * MINUTE,
  compose_build: 40 * MINUTE,
  compose_up: 10 * MINUTE,
  host_script: 5 * MINUTE,
  http_fetch: 30_000,
  host_probe: 10_000,
};

/** 外部コマンドの標準エラーで、末尾から残す大きさ(バイト)。超えた先頭は捨てる。 */
export const STDERR_LIMIT_BYTES = 64 * 1024;

/** コミットから読むファイルの大きさの上限(バイト)。 */
export const MAX_BLOB_BYTES = 256 * 1024;

/**
 * 値が変わると、形式に合っていても承認が要るキー。
 * `CONSOLE_GITHUB_REPO`は、Consoleの配信物の取得元を決める。形式だけでは、取得元が正しいかを確かめられない。
 */
export const MISE_APPROVAL_KEYS: readonly string[] = ["CONSOLE_GITHUB_REPO"];

/** 1回の実行全体の上限。 */
export const RUN_TIMEOUT_MS = 90 * MINUTE;

/**
 * 排水の待ちの上限。
 * 実装フローのステップのtimeout(21600秒)に、30分を足した値。
 * 超えても強制終了せず、通知して待ちを続ける。
 */
export const DRAIN_LIMIT_MS = 21_600_000 + 30 * MINUTE;

/** 心拍を書き直す間隔。 */
export const HEARTBEAT_INTERVAL_MS = MINUTE;

/** 心拍がこれより古ければ、実行役が止まったとみなす。 */
export const HEARTBEAT_STALE_MS = 30 * MINUTE;

/** 同じ理由の通知を繰り返す最短の間隔。 */
export const NOTIFY_INTERVAL_MS = 24 * HOUR;

/** 目標がこの時間、CIを通らなければ通知する。 */
export const STALE_CI_MS = 24 * HOUR;

/** 同じ目標で連続して失敗したときに通知する回数。 */
export const FAILED_NOTIFY_AFTER = 3;

/** 失敗がこの回数を超えたら、再試行を間引く。 */
export const ATTEMPT_THROTTLE_AFTER = 3;

/** 間引いたときの再試行の間隔。 */
export const ATTEMPT_THROTTLE_INTERVAL_MS = 30 * MINUTE;
