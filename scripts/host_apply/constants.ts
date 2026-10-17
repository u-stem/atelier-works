/** 実行役が判定に使う定数。閾値、外部コマンドの上限、必須チェックの名前をここに集める。 */

export const REQUIRED_CHECKS: readonly string[] = [];

export const CI_WORKFLOW_PATH = "";

export const MISE_ENV_KEYS: readonly string[] = [];

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
  | "http_fetch";

export const COMMAND_KINDS: readonly CommandKind[] = [];

export const COMMAND_TIMEOUT_MS: Readonly<Record<CommandKind, number>> = {
  git_read: 0,
  git_fetch: 0,
  git_worktree_add: 0,
  docker_inspect: 0,
  docker_ps: 0,
  docker_volume_ls: 0,
  launchctl: 0,
  compose_dry_run: 0,
  compose_pull: 0,
  compose_build: 0,
  compose_up: 0,
  host_script: 0,
  http_fetch: 0,
};

export const RUN_TIMEOUT_MS = 0;
export const DRAIN_LIMIT_MS = 0;
export const HEARTBEAT_INTERVAL_MS = 0;
export const HEARTBEAT_STALE_MS = 0;
export const NOTIFY_INTERVAL_MS = 0;
export const STALE_CI_MS = 0;
export const FAILED_NOTIFY_AFTER = 0;
export const ATTEMPT_THROTTLE_AFTER = 0;
export const ATTEMPT_THROTTLE_INTERVAL_MS = 0;
