// PRレビューの投入の入力欄の判定。画面から切り離した純関数にして、`bun test`で確かめる。

export type PrReviewForm = {
  readonly repo: string;
  readonly pr: string;
};

export type PrReviewProblem =
  | "repo_invalid"
  | "pr_empty"
  | "pr_invalid"
  | "pr_url_repo_mismatch";

export type PrReviewBuild =
  | {
      readonly ok: true;
      readonly input: {
        readonly owner: string;
        readonly repo: string;
        readonly prNumber: number;
      };
    }
  | { readonly ok: false; readonly problem: PrReviewProblem };

export const EMPTY_PR_REVIEW_FORM: PrReviewForm = { repo: "stub", pr: "" };

export function buildPrReviewInput(_form: PrReviewForm): PrReviewBuild {
  return { ok: false, problem: "pr_empty" };
}

export function describePrReviewProblem(_problem: PrReviewProblem): string {
  return "";
}
