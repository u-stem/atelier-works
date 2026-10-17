/** gitの呼び出しの引数と環境を作る。実行はしない。引数は配列で、シェルを経由しない。 */

export function isSha40(_value: string): boolean {
  return true;
}

export function fetchArgs(): string[] {
  return [];
}

export function fetchEnv(_token: string | null): Record<string, string> {
  return {};
}

export function remoteUrlMatches(_actual: string, _recorded: string): boolean {
  return true;
}

/** `plan`が使うgitのサブコマンド。読み取りだけを列挙する。 */
export const PLAN_GIT_SUBCOMMANDS: readonly string[] = [];

export function readOnlyGitArgs(_args: readonly string[]): string[] {
  return [];
}

export function showBlobArgs(_sha: string, _path: string): string[] {
  return [];
}

export function diffNameStatusArgs(_base: string, _target: string): string[] {
  return [];
}

export function isAncestorArgs(
  _ancestor: string,
  _descendant: string,
): string[] {
  return [];
}

export function commitExistsArgs(_sha: string): string[] {
  return [];
}
