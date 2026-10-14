// 再実行の操作について、ロックのキーと、結果の知らせの内容を決める純粋関数。

import { isResultUnknown, type WriteOutcome } from "../api/executeWrite.ts";
import type { RetryWorkItemResult } from "../api/guards/writeResults.ts";
import { writeTargetKey } from "../api/writeLocks.ts";
import { describeRetryResult, type WriteNotice } from "./writeNotices.ts";

export type RetryInput = { readonly workItemId: number };

/**
 * 再実行のロックのキー。作業項目ごとに別のキーにする。
 * 失敗の行の1つを再実行している間も、ほかの行は再実行できる。
 */
export function retryTargetKey(input: RetryInput): string {
  return writeTargetKey("work_item", input.workItemId);
}

/** 再実行の知らせ。成功と確認の要る結果は`WriteNotice`、確定した失敗は`error`にする。 */
export type RetryNotice =
  | WriteNotice
  | { readonly tone: "error"; readonly message: string };

/**
 * 再実行の結果を、画面に出す知らせにする。
 * 失敗の文は`describeWriteFailure`が作る。結果が分からない失敗の文には、一覧を読み直して確かめる案内が入る。
 * 結果が分からない失敗は、効いたかもしれないので警告にする。
 * ジョブが動く前に断られた失敗(認証と認可、4xx)は、効いていないのでエラーにする。
 */
export function describeRetryOutcome(
  outcome: WriteOutcome<RetryWorkItemResult>,
): RetryNotice {
  if (outcome.kind === "done") {
    return describeRetryResult(outcome.result);
  }
  return {
    tone: isResultUnknown(outcome.error) ? "warning" : "error",
    message: outcome.message,
  };
}
