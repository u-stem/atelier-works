/**
 * 読み取りのgitの指定を作る。
 * `plan`と`approve`の入口が使う。ネットワークに触れる取得の指定は`run_fetch.ts`にあり、ここには無い。
 * 引数は`git.ts`の組み立て関数が作ったもので、文法の検査は`issueSpec`が行う。
 */

import { type IssuedSpec, issueSpec } from "./command.ts";
import { COMMAND_TIMEOUT_MS } from "./constants.ts";
import { GIT_BIN } from "./exec_paths.ts";
import { approveGitEnv } from "./git.ts";

export type GitReadOptions = {
  /** gitを実行するディレクトリ。絶対パス。 */
  readonly cwd: string;
  /** 標準出力の上限。種類の天井(64MiB)より下げることだけできる。 */
  readonly maxStdoutBytes?: number;
};

/** 読み取りのgitを実行する指定を発行する。文法に合わない引数は例外にする。 */
export function gitReadSpec(
  args: readonly string[],
  options: GitReadOptions,
): IssuedSpec {
  return issueSpec({
    kind: "git_read",
    bin: GIT_BIN,
    args,
    env: approveGitEnv(),
    cwd: options.cwd,
    timeoutMs: COMMAND_TIMEOUT_MS.git_read,
    ...(options.maxStdoutBytes === undefined
      ? {}
      : { maxStdoutBytes: options.maxStdoutBytes }),
  });
}
