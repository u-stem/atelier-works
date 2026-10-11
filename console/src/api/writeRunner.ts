// 書き込み1回分の結線。ロック、実行、結果の知らせ、読み直し、読み直せなかったときの待ちをつなぐ。
// Reactに依存しないので、実際のQueryClientで`bun test`にかけられる。
// `mutations.ts`のフックは、これをTanStack Queryのmutationに載せるだけにする。

import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { ApiFailure } from "./errors.ts";
import { executeWrite, type WriteOutcome } from "./executeWrite.ts";
import { summaryQueryKey } from "./queries.ts";
import { holdUntilFresh } from "./staleHold.ts";
import { runLocked, type WriteLocks, writeLocks } from "./writeLocks.ts";

export type WriteRunnerConfig<TInput, TResult> = {
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

export type WriteRunnerDeps<TInput, TResult> = WriteRunnerConfig<
  TInput,
  TResult
> & {
  readonly queryClient: Pick<
    QueryClient,
    "invalidateQueries" | "getQueryCache"
  >;
};

const DEFAULT_INVALIDATES: readonly QueryKey[] = [summaryQueryKey];

/**
 * 書き込みを1回実行する関数を作る。
 * 同じキーが止まっているときは、実行せずに`null`を返す。
 * 失敗は`ApiFailure`で投げる。401を取得と同じ経路でログインの帯に流すためである。
 * 投げる前に、ロックの扱いは済ませてある。
 * ロックは実行の中で取る。同じ瞬間に2回呼ばれても、実行は1回になる。
 */
export function createWriteRunner<TInput, TResult>(
  deps: WriteRunnerDeps<TInput, TResult>,
): (input: TInput) => Promise<TResult | null> {
  const locks = deps.locks ?? writeLocks;
  const queryKeys = deps.invalidates ?? DEFAULT_INVALIDATES;

  return async (input) => {
    const ran = await runLocked(
      locks,
      deps.keyOf(input),
      async () => {
        const run = await executeWrite({
          run: () => deps.run(input),
          refetch: () =>
            Promise.all(
              queryKeys.map((queryKey) =>
                deps.queryClient.invalidateQueries(
                  { queryKey },
                  { throwOnError: true },
                ),
              ),
            ),
          onOutcome: (outcome) => {
            deps.onOutcome(outcome, input);
          },
          onStale: () => {
            deps.onStale(input);
          },
        });
        return { value: run.outcome, keepLocked: !run.refetched };
      },
      (release) => {
        holdUntilFresh(deps.queryClient.getQueryCache(), queryKeys, release);
      },
    );
    if (!ran.started) {
      return null;
    }
    if (ran.value.kind === "failed") {
      throw new ApiFailure(ran.value.error);
    }
    return ran.value.result;
  };
}
