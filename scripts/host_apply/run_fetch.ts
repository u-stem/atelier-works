/**
 * 取得のgit(`git_fetch`)の指定と、取得先の照合。ネットワークに触れる唯一の経路。
 * 取得の前に、リポジトリの`remote.origin.url`が導入時に記録したURLと一致することを確かめ、
 * 取得にはその検査済みのURLを直接渡す。名前(`origin`)で取得すると、照合したURLと取得するURLが食い違いうる。
 * トークンは環境の`GIT_CONFIG_*`にだけ入れ、引数には載せない。
 */

import { type CommandRunner, type IssuedSpec, issueSpec } from "./command.ts";
import { COMMAND_TIMEOUT_MS } from "./constants.ts";
import { GIT_BIN } from "./exec_paths.ts";
import {
  approveGitEnv,
  fetchArgs,
  fetchEnv,
  REMOTE_URL_PATTERN,
  remoteUrlMatches,
} from "./git.ts";
import { REMOTE_URL_ARGS } from "./git_grammar.ts";

/**
 * 取得の結果。失敗は終了コードだけを返し、gitの出力は返さない。
 * 出力に取得先の内部の情報や認証の断片が混ざりうるため。
 * `code`が`null`なのは、終了コードを得る前に打ち切ったとき。
 */
export type FetchResult =
  | { readonly kind: "fetched" }
  | { readonly kind: "url_mismatch" }
  | { readonly kind: "failed"; readonly code: number | null };

export type FetchInput = {
  /** 取得先のリポジトリ(bare)の絶対パス。`GIT_DIR`と作業ディレクトリにする。 */
  readonly repoGit: string;
  /** 導入時に記録した取得先のURL。 */
  readonly recordedUrl: string;
  readonly token: string | null;
};

/** `remote.origin.url`を、リポジトリの設定から読む指定。 */
export function remoteUrlSpec(repoGit: string): IssuedSpec {
  return issueSpec({
    kind: "git_fetch",
    bin: GIT_BIN,
    args: REMOTE_URL_ARGS,
    env: { ...approveGitEnv(), GIT_DIR: repoGit },
    cwd: repoGit,
    timeoutMs: COMMAND_TIMEOUT_MS.git_fetch,
  });
}

function fetchSpec(input: FetchInput): IssuedSpec {
  return issueSpec({
    kind: "git_fetch",
    bin: GIT_BIN,
    args: fetchArgs(input.recordedUrl),
    env: {
      ...approveGitEnv(),
      ...fetchEnv(input.token),
      GIT_DIR: input.repoGit,
    },
    cwd: input.repoGit,
    timeoutMs: COMMAND_TIMEOUT_MS.git_fetch,
  });
}

/**
 * `origin/main`を取得する。
 * 記録したURLがGitHubのhttpsの形でなければ、何も実行せず`url_mismatch`にする。
 * 設定のURLは、ちょうど1行で、同じ形で、記録したURLと一致するときだけ取得に進む。
 */
export async function fetchOrigin(
  run: CommandRunner,
  input: FetchInput,
  opts?: { readonly signal?: AbortSignal },
): Promise<FetchResult> {
  if (!REMOTE_URL_PATTERN.test(input.recordedUrl)) {
    return { kind: "url_mismatch" };
  }
  const read = await run(remoteUrlSpec(input.repoGit), opts);
  if (read.kind !== "done") return { kind: "failed", code: null };
  if (read.code !== 0) return { kind: "failed", code: read.code };
  const actual = read.stdout.replace(/\n$/, "");
  if (
    read.stdoutDropped ||
    actual.includes("\n") ||
    !REMOTE_URL_PATTERN.test(actual) ||
    !remoteUrlMatches(read.stdout, input.recordedUrl)
  ) {
    return { kind: "url_mismatch" };
  }
  const fetched = await run(fetchSpec(input), opts);
  if (fetched.kind !== "done") return { kind: "failed", code: null };
  return fetched.code === 0
    ? { kind: "fetched" }
    : { kind: "failed", code: fetched.code };
}
