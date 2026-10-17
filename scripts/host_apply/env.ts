/** 子プロセスの環境を許可リストで組み立てる。親のプロセスの環境は引き継がない。 */

export type EnvProfile = "compose" | "admin_script" | "git" | "plain";

export const COMPOSE_ENV_NAMES: readonly string[] = [];

export const ADMIN_SCRIPT_ENV_NAMES: readonly string[] = [];

export const ADMIN_CREDENTIAL_NAMES: readonly string[] = [];

export type EnvInput = {
  readonly path: string;
  readonly home: string;
  /** 静的に読んだ値。`mise.local.toml`と`mise.toml`の`[env]`から作る。 */
  readonly values: Readonly<Record<string, string>>;
};

export function buildChildEnv(
  _profile: EnvProfile,
  _input: EnvInput,
): Record<string, string> {
  return { LEAK: "stub" };
}
