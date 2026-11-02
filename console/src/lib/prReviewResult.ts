// 投入したフローのジョブの結果から、画面に出す状態を決める。画面から切り離した純関数にして、`bun test`で確かめる。
// フローの結果は、登録のステップの戻りである。ジョブの詳細の取得は、ログと結果を含む取得(`output`)と、
// 実行中の間だけ15秒ごとに繰り返す状態の取得(`status`)の2つがある。
// ジョブが終わったと状態の取得で分かったとき、結果つきの取得は1回だけ取り直される。失敗しても繰り返さない。

import {
  isPrReviewRegisterResult,
  type PrReviewRegisterRefusalReason,
} from "../api/guards/writeResults.ts";
import { currentJob, type DetailSnapshot } from "../api/jobsQueries.ts";
import { isFinishedJobState } from "./jobsView.ts";
import { describePrReviewRegisterRefusal } from "./prReviewRefusal.ts";

export type PrReviewResultState =
  /** 取得に失敗した。取り直しの操作を出す。 */
  | { readonly kind: "unavailable" }
  /** 取得できたが、結果を読めない。ジョブを開いて確かめる。 */
  | { readonly kind: "unreadable" }
  | { readonly kind: "waiting" }
  | { readonly kind: "started"; readonly workItemId: number }
  | {
      readonly kind: "refused";
      readonly reason: PrReviewRegisterRefusalReason;
    };

export type PrReviewResultInput = {
  /** ログと結果を含む取得。`isError`は、最初の取得と取り直しのどちらの失敗でも真になる。 */
  readonly output: DetailSnapshot & { readonly isError: boolean };
  /** 状態の取得。`isError`は、直近の取得が失敗したままなら真になる。 */
  readonly status: DetailSnapshot & { readonly isError: boolean };
};

/** 結果の文字列をJSONとして読む。読めなければ`undefined`を返す。 */
function parseJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

/**
 * 結果を、上の行から順に評価した最初の状態にする。
 * 1. 取得に失敗した。
 * 2. 結果の取得にサーバーが失敗を付けた。
 * 3. ジョブが見つからない、失敗か取り消しか飛ばされた、終わっているのに結果が無い、
 *    切り詰められたか伏せられた、JSONでない、登録の結果の形でない。
 * 4. 最初の取得が終わっていない、ジョブが実行中か待ちか知らない状態、
 *    状態の取得は終わりを見たが結果つきの取得が古い。
 * 5. 成功して`started`、6. 成功して`refused`。
 */
export function prReviewResultState(
  input: PrReviewResultInput,
): PrReviewResultState {
  const { output, status } = input;
  if (output.isError) {
    return { kind: "unavailable" };
  }
  const data = output.data;
  if (data === undefined) {
    return { kind: "waiting" };
  }
  if (!data.found) {
    return { kind: "unreadable" };
  }
  if (data.result_error !== null) {
    return { kind: "unavailable" };
  }
  const job = currentJob(output, status) ?? data.job;
  if (
    job.state === "failure" ||
    job.state === "canceled" ||
    job.state === "skipped"
  ) {
    return { kind: "unreadable" };
  }
  // 結果つきの取得が、終わる前の読み取りのままなら、結果はまだ読めていない。
  if (job.state !== "success" || !isFinishedJobState(data.job.state)) {
    return { kind: "waiting" };
  }
  const result = data.result;
  if (result === null || result.truncated || result.masked) {
    return { kind: "unreadable" };
  }
  const value = parseJson(result.text);
  if (!isPrReviewRegisterResult(value)) {
    return { kind: "unreadable" };
  }
  return value.status === "started"
    ? { kind: "started", workItemId: value.work_item_id }
    : { kind: "refused", reason: value.reason };
}

/** 取り直しの操作を出すか。取得の失敗のときだけ出す。読めない結果は取り直しても変わらない。 */
export function offersRetry(state: PrReviewResultState): boolean {
  return state.kind === "unavailable";
}

/** 画面に出す結果の知らせ。 */
export type PrReviewResultView = {
  readonly tone: "default" | "warning" | "error";
  readonly headline: string;
  readonly lines: readonly string[];
};

/** 状態を、画面に出す知らせにする。作業項目とジョブへのリンクは、画面が足す。 */
export function describePrReviewResult(
  state: PrReviewResultState,
): PrReviewResultView {
  switch (state.kind) {
    case "waiting":
      return { tone: "default", headline: "結果を待っています", lines: [] };
    case "unavailable":
      return {
        tone: "error",
        headline: "結果を取得できません",
        lines: [
          "ジョブの結果を読み込めませんでした。もう一度取得するか、ジョブを開いて確認してください。",
        ],
      };
    case "unreadable":
      return {
        tone: "warning",
        headline: "結果を読み取れません。ジョブを開いて確認してください",
        lines: [],
      };
    case "started":
      return { tone: "default", headline: "レビューを始めました", lines: [] };
    case "refused":
      return {
        tone: "error",
        headline: describePrReviewRegisterRefusal(state.reason),
        lines: [],
      };
  }
}
