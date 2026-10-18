/** 読み取りのgitと取得のgitの引数・環境の文法。 */

export const REMOTE_URL_ARGS: readonly string[] = [];

export function checkGitReadArgs(_args: readonly string[]): string | null {
  return null;
}

export function checkGitReadEnv(
  _env: Readonly<Record<string, string>>,
): string | null {
  return null;
}

export type FetchForm = {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
};

export function checkFetchForm(_form: FetchForm): string | null {
  return null;
}
