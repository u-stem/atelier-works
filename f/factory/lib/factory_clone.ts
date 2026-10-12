// Factory自身のcloneを、`factory_repo_id`の照合を通して用意する。
// self_update以外のscriptは、`ensureFactoryClone`を直接呼ばず、これを使う。
// self_updateは、各呼び出しに上限を付けるため、`ensureVerifiedFactoryClone`に自前の依存を渡す。

import { addNoticeUnlessUnresolved } from "./db.ts";
import {
  type EnsureVerifiedFactoryCloneDeps,
  ensureVerifiedFactoryClone,
} from "./factory_repo_gate.ts";
import { getRepositoryId } from "./github.ts";
import { withCallTimeout } from "./self_update_support.ts";
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
 * `deps`は、noticeの記録とcloneの用意を差し替えるテスト用で、省略すると本物を使う。
 */
export function openFactoryClone(
  config: FactoryConfig,
  options: OpenFactoryCloneOptions,
  deps: Partial<
    Pick<EnsureVerifiedFactoryCloneDeps, "addNotice" | "ensureClone">
  > = {},
): Promise<EnsureFactoryCloneResult> {
  return ensureVerifiedFactoryClone(config, options, {
    getRepositoryId: (owner, repo) =>
      // cloneのロックを持ったまま呼ぶので、他の処理を長く塞がないよう、上限で区切る。
      // この上限(`withCallTimeout`の既定の30秒)は、self_updateと共用している。
      withCallTimeout("getRepositoryId factory_repo", () =>
        getRepositoryId(
          { run: options.run, ghToken: options.ghToken },
          owner,
          repo,
        ),
      ),
    addNotice:
      deps.addNotice ??
      ((record) =>
        withCallTimeout("addNotice factory_repo_id", () =>
          addNoticeUnlessUnresolved(record),
        )),
    ...(deps.ensureClone === undefined
      ? {}
      : { ensureClone: deps.ensureClone }),
  });
}
