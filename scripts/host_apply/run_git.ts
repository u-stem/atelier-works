/** 読み取りのgitの指定を作る。 */

import { IssuedSpec } from "./command.ts";

export type GitReadOptions = {
  readonly cwd: string;
  readonly maxStdoutBytes?: number;
};

export function gitReadSpec(
  _args: readonly string[],
  options: GitReadOptions,
): IssuedSpec {
  return new IssuedSpec({
    kind: "git_read",
    bin: "",
    args: [],
    env: {},
    cwd: options.cwd,
    timeoutMs: 0,
    maxStdoutBytes: 0,
    overflow: "kill",
  });
}
