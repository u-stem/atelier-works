/** 実行しているコードの出どころの検査。 */

import type { GitRunner } from "./plan_git.ts";

export type OriginCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export type CodeOriginInput = {
  /** スクリプト自身のリポジトリのトップで実行するgit。 */
  readonly run: GitRunner;
  /** スクリプト自身のリポジトリのトップ。 */
  readonly repoRoot: string;
  readonly cwd: string;
};

export function gitBlobSha1(_content: Uint8Array): string {
  return "";
}

export async function checkCodeOrigin(
  _input: CodeOriginInput,
): Promise<OriginCheck> {
  return { ok: true };
}
