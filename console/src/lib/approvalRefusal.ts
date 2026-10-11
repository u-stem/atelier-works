// approval_decideが、ジョブの中で確定して断った理由を、日本語の固定文と取れる手にする。
// scriptの断りはジョブの失敗として返り、本文は英語である。
// Windmillは失敗の文に`Error: `などを前置きすることがあるので、文頭は見ない。
// 他のscriptの失敗と取り違えないよう、断りの文に固有の部分だけを根拠にする。
// 断りは、承認の記録より前に起きる。記録も起動もされていない。

import type { ApiError } from "../api/errors.ts";

type RefusalKind =
  | "changed"
  | "unavailable"
  | "conflict"
  | "reason_required"
  | "missing";

export type DecisionRefusal = {
  readonly kind: RefusalKind;
  readonly message: string;
  /** 承認者が取れる手。 */
  readonly actions: readonly string[];
};

const REFUSALS: readonly {
  readonly marker: string;
  readonly refusal: DecisionRefusal;
}[] = [
  {
    marker: "the issue title or body changed after intake",
    refusal: {
      kind: "changed",
      message:
        "Issueが取り込みの後に書き換えられているため、承認は記録されていません。",
      actions: [
        "Issueを取り込み時点の内容に戻してから、もう一度承認する。",
        "現在のIssueの内容を使うなら、却下する。要件定義を現在のIssueから作り直し、新しい承認が要る。",
      ],
    },
  },
  {
    marker: "the issue could not be compared",
    refusal: {
      kind: "unavailable",
      message:
        "現在のIssueを取り込み内容と比べられなかったため、承認は記録されていません。",
      actions: [
        "少し待って、もう一度承認する。",
        "Issueを移したか削除したなら、却下する。",
      ],
    },
  },
  {
    marker: "already has a recorded decision",
    refusal: {
      kind: "conflict",
      message:
        "この依頼には、別の決定が記録済みか、期限が切れています。決定は上書きされません。",
      actions: ["一覧を読み直して、依頼の状態を確かめる。"],
    },
  },
  {
    marker: "is required when decision is",
    refusal: {
      kind: "reason_required",
      message: "却下には理由が必要です。",
      actions: ["理由を入力して、もう一度却下する。"],
    },
  },
  {
    marker: "no approval request with id",
    refusal: {
      kind: "missing",
      message: "この承認依頼が見つかりません。",
      actions: ["一覧を読み直して、依頼の状態を確かめる。"],
    },
  },
];

/**
 * 承認の失敗が、approval_decideの確定した断りなら、その説明を返す。そうでなければ`null`。
 * 文の出どころはbackendの`approval_decide.ts`と`approval_support.ts`で、契約テストが突き合わせる。
 * `null`のときは、結果が分からない失敗の案内を使う。
 */
export function classifyDecisionRefusal(
  error: ApiError,
): DecisionRefusal | null {
  if (error.kind !== "job_failed") {
    return null;
  }
  const message = error.message;
  const found = REFUSALS.find(({ marker }) => message.includes(marker));
  return found?.refusal ?? null;
}
