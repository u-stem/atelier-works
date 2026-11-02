// 調査のClaudeに、読み出しを塞ぐ固定の一覧を渡す設定を作る。
// 保護パスに置く。一覧や書き出しの条件を緩めると、調査のClaudeがworkerの秘密に届くため。

export class ReadDenyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadDenyError";
  }
}

export const READ_DENY_BASE_PATHS: readonly string[] = [];

export function buildReadDenyPaths(_home: string): readonly string[] {
  return [];
}

export function readDenyRules(_paths: readonly string[]): string[] {
  return [];
}

export function buildReadDenySettings(_paths: readonly string[]): string {
  return "";
}

export type ReadDenyContext = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly root?: string;
};

export function assertCwdOutsideDeny(
  _cwd: string,
  _paths: readonly string[],
  _realpath?: (path: string) => string | null,
): void {}

export function assertJobConfigDir(
  _configDir: string | undefined,
  _context?: ReadDenyContext,
): string {
  return "";
}

export async function prepareReadDenySettings(_input: {
  readonly readDenyPaths: readonly string[];
  readonly configDir: string | undefined;
  readonly cwd: string;
  readonly context?: ReadDenyContext;
}): Promise<void> {}
