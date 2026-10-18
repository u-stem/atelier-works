/** 取得のgitの指定と、取得先の照合。 */

import { type CommandRunner, IssuedSpec } from "./command.ts";

export type FetchResult =
  | { readonly kind: "fetched" }
  | { readonly kind: "url_mismatch" }
  | { readonly kind: "failed"; readonly code: number | null };

export type FetchInput = {
  readonly repoGit: string;
  readonly recordedUrl: string;
  readonly token: string | null;
};

export function remoteUrlSpec(repoGit: string): IssuedSpec {
  return new IssuedSpec({
    kind: "git_fetch",
    bin: "",
    args: [],
    env: {},
    cwd: repoGit,
    timeoutMs: 0,
    maxStdoutBytes: 0,
    overflow: "drain",
  });
}

export async function fetchOrigin(
  _run: CommandRunner,
  _input: FetchInput,
  _opts?: { readonly signal?: AbortSignal },
): Promise<FetchResult> {
  return { kind: "failed", code: null };
}
