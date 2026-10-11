// 書き込み(mutation)の共通のフック。
// 対象のキー単位でボタンをロックし、自動では再試行せず、
// 成功と結果が分からない失敗の後に関連する取得を読み直す。
// 読み直せなかったときは、一覧が更新されるまで、その対象を止めたままにする。
// 結線は`createWriteRunner`にあり、実際のQueryClientで`bun test`にかけている。
// このフックは、それをTanStack Queryのmutationと画面のロックの表示につなぐだけにする。

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import { writeLocks } from "./writeLocks.ts";
import { createWriteRunner, type WriteRunnerConfig } from "./writeRunner.ts";

type WriteMutationConfig<TInput, TResult> = WriteRunnerConfig<TInput, TResult>;

type WriteMutation<TInput> = {
  /** 始められれば`true`。同じ対象が実行中か、一覧が古いなら何もせず`false`を返す。 */
  readonly submit: (input: TInput) => boolean;
  /** `input`の対象が止まっているか。ボタンを無効にするのに使う。 */
  readonly isLocked: (input: TInput) => boolean;
};

/**
 * 書き込みの操作を、ロックと読み直し付きで実行するフック。
 * 同じタブの中でだけ二重の送信を止める。複数のタブやリロードの後は止められない。
 * 401は`ApiFailure`として投げ直し、取得と同じ経路でログインの帯に流す。
 * 再試行はしない。結果が分からないまま2回実行しないためである。
 * `networkMode`は`always`にする。オフラインで待機に入ると、ロックが解けなくなるためである。
 */
export function useWriteMutation<TInput, TResult>(
  config: WriteMutationConfig<TInput, TResult>,
): WriteMutation<TInput> {
  const queryClient = useQueryClient();
  const locks = config.locks ?? writeLocks;
  const held = useSyncExternalStore(locks.subscribe, locks.getSnapshot);

  const mutation = useMutation({
    networkMode: "always",
    retry: 0,
    mutationFn: (input: TInput) =>
      createWriteRunner({ ...config, queryClient, locks })(input),
  });

  const { mutate } = mutation;
  const keyOf = config.keyOf;

  const submit = useCallback(
    (input: TInput): boolean => {
      if (locks.isLocked(keyOf(input))) {
        return false;
      }
      mutate(input);
      return true;
    },
    [locks, keyOf, mutate],
  );

  return {
    submit,
    isLocked: (input) => held.has(keyOf(input)),
  };
}
