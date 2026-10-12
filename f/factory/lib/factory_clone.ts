// Factory自身のcloneを、`factory_repo_id`の照合を通して用意する。
// self_update以外のscriptは、`ensureFactoryClone`を直接呼ばず、これを使う。
// self_updateは、各呼び出しに上限を付けるため、`ensureVerifiedFactoryClone`に自前の依存を渡す。

import { addNoticeUnlessUnresolved } from "./db.ts";
import { ensureVerifiedFactoryClone } from "./factory_repo_gate.ts";
import { getRepositoryId } from "./github.ts";
import type { FactoryConfig } from "./types.ts";
import type { CommandRunner, EnsureFactoryCloneResult } from "./workspace.ts";

export type OpenFactoryCloneOptions = {
  readonly run: CommandRunner;
  readonly ghToken: string;
};

/**
 * `config.factory_repo`を、`config.factory_repo_id`で照合してから、cloneを用意する。
 * 照合に落ちると、noticeを残して`FactoryRepoIdMismatchError`を投げる。
 * 呼び出し側の既存のエラー処理(フローの失敗など)に乗せる。
 */
export function openFactoryClone(
  config: Pick<
    FactoryConfig,
    "factory_repo" | "factory_repo_id" | "factory_branch"
  >,
  options: OpenFactoryCloneOptions,
): Promise<EnsureFactoryCloneResult> {
  return ensureVerifiedFactoryClone(config, options, {
    getRepositoryId: (owner, repo) =>
      getRepositoryId(
        { run: options.run, ghToken: options.ghToken },
        owner,
        repo,
      ),
    addNotice: (record) => addNoticeUnlessUnresolved(record),
  });
}
