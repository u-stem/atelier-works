// 書き込み(mutation)の共通のフック。
// 対象のキー単位でボタンをロックし、自動では再試行せず、
// 成功と結果が分からない失敗の後に関連する取得を読み直す。
// 読み直せなかったときは、一覧が更新されるまで、その対象を止めたままにする。
// 実行の流れは`executeWrite`、ロックは`runLocked`と`writeLocks`、
// 止めたままにする待ちは`holdUntilFresh`でテストしている。
// このフックは、それらをTanStack Queryと画面につなぐだけにする。

import {
  type QueryKey,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import { ApiFailure } from "./errors.ts";
import { executeWrite, type WriteOutcome } from "./executeWrite.ts";
import { summaryQueryKey } from "./queries.ts";
import { holdUntilFresh } from "./staleHold.ts";
import { runLocked, type WriteLocks, writeLocks } from "./writeLocks.ts";

export type WriteMutationConfig<TInput, TResult> = {
  /** ロックのキー。同じ対象への操作は、同じキーを返す。 */
  readonly keyOf: (input: TInput) => string;
  /** `writes.ts`の型付きの関数を呼ぶ。 */
  readonly run: (input: TInput) => Promise<TResult>;
  /** 結果の知らせ(トーストなど)。結果の文は`lib/writeNotices.ts`で作る。 */
  readonly onOutcome: (outcome: WriteOutcome<TResult>, input: TInput) => void;
  /** 一覧を読み直せなかったときの知らせ。文は`STALE_LIST_NOTICE`を使う。 */
  readonly onStale: (input: TInput) => void;
  /** 書き込みの後に読み直す取得。既定は、件数と一覧を持つsummary。 */
  readonly invalidates?: readonly QueryKey[];
  /** テストと差し替え用。既定は画面全体で共有するロック。 */
  readonly locks?: WriteLocks;
};

export type WriteMutation<TInput> = {
  /** 始められれば`true`。同じ対象が実行中か、一覧が古いなら何もせず`false`を返す。 */
  readonly submit: (input: TInput) => boolean;
  /** `input`の対象が止まっているか。ボタンを無効にするのに使う。 */
  readonly isLocked: (input: TInput) => boolean;
};

const DEFAULT_INVALIDATES: readonly QueryKey[] = [summaryQueryKey];

/**
 * 書き込みの操作を、ロックと読み直し付きで実行するフック。
 * 同じタブの中でだけ二重の送信を止める。複数のタブやリロードの後は止められない。
 * 401は`ApiFailure`として投げ直し、取得と同じ経路でログインの帯に流す。
 * 再試行はしない。結果が分からないまま2回実行しないためである。
 * `networkMode`は`always`にする。オフラインで待機に入ると、ロックが解けなくなるためである。
 * ロックは`mutationFn`の中で取る。同じ瞬間に2回押されても、実行は1回だけになる。
 */
export function useWriteMutation<TInput, TResult>(
  config: WriteMutationConfig<TInput, TResult>,
): WriteMutation<TInput> {
  const queryClient = useQueryClient();
  const locks = config.locks ?? writeLocks;
  const held = useSyncExternalStore(locks.subscribe, locks.getSnapshot);
  const queryKeys = config.invalidates ?? DEFAULT_INVALIDATES;

  const mutation = useMutation({
    networkMode: "always",
    retry: 0,
    mutationFn: async (input: TInput): Promise<TResult | null> => {
      const ran = await runLocked(
        locks,
        config.keyOf(input),
        async () => {
          const run = await executeWrite({
            run: () => config.run(input),
            refetch: () =>
              Promise.all(
                queryKeys.map((queryKey) =>
                  queryClient.invalidateQueries(
                    { queryKey },
                    { throwOnError: true },
                  ),
                ),
              ),
            onOutcome: (outcome) => {
              config.onOutcome(outcome, input);
            },
            onStale: () => {
              config.onStale(input);
            },
          });
          return { value: run.outcome, keepLocked: !run.refetched };
        },
        (release) => {
          holdUntilFresh(queryClient.getQueryCache(), queryKeys, release);
        },
      );
      if (!ran.started) {
        return null;
      }
      if (ran.value.kind === "failed") {
        throw new ApiFailure(ran.value.error);
      }
      return ran.value.result;
    },
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
