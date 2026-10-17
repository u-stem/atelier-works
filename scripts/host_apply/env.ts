/** 子プロセスの環境を許可リストで組み立てる。親のプロセスの環境は引き継がない。 */

import { MISE_ENV_KEYS } from "./constants.ts";

/**
 * 子プロセスの種類。
 * `compose`はdocker compose、`admin_script`は`doctor.sh`と`bootstrap.sh custom-tags`、
 * `git`は取得などのgit、`plain`はそれ以外。
 */
export type EnvProfile = "compose" | "admin_script" | "git" | "plain";

/** composeに渡す名前。列挙した`mise.toml`のキーと、composeが参照する2つの秘密値。 */
export const COMPOSE_ENV_NAMES: readonly string[] = [
  ...MISE_ENV_KEYS,
  "DB_PASSWORD",
  "CONSOLE_GITHUB_TOKEN",
];

/** Windmillの管理者の資格。`admin_script`にだけ渡す。 */
export const ADMIN_CREDENTIAL_NAMES: readonly string[] = [
  "WM_ADMIN_EMAIL",
  "WM_ADMIN_PASSWORD",
];

/** `doctor.sh`が確かめる必須の環境変数を含む、`admin_script`に渡す名前。 */
export const ADMIN_SCRIPT_ENV_NAMES: readonly string[] = [
  ...COMPOSE_ENV_NAMES,
  ...ADMIN_CREDENTIAL_NAMES,
  "GITHUB_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "DISCORD_WEBHOOK_URL",
];

export type EnvInput = {
  readonly path: string;
  readonly home: string;
  /** 静的に読んだ値。`mise.local.toml`と`mise.toml`の`[env]`から作る。 */
  readonly values: Readonly<Record<string, string>>;
};

const PROFILE_NAMES: Readonly<Record<EnvProfile, readonly string[]>> = {
  compose: COMPOSE_ENV_NAMES,
  admin_script: ADMIN_SCRIPT_ENV_NAMES,
  git: [],
  plain: [],
};

/**
 * 子プロセスの環境を、許可リストだけで作る。
 * `PATH`と`HOME`に、種類ごとの名前の値を足す。親の`process.env`は読まない。
 * 名前が許可リストに無い値は、`values`にあっても渡さない。
 */
export function buildChildEnv(
  profile: EnvProfile,
  input: EnvInput,
): Record<string, string> {
  const env: Record<string, string> = { PATH: input.path, HOME: input.home };
  for (const name of PROFILE_NAMES[profile]) {
    const value = input.values[name];
    if (value !== undefined) env[name] = value;
  }
  if (profile === "git") {
    env.GIT_TERMINAL_PROMPT = "0";
    env.GIT_CONFIG_NOSYSTEM = "1";
  }
  return env;
}
