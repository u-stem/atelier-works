// PRレビューの投入の入力欄の判定。画面から切り離した純関数にして、`bun test`で確かめる。
// 検証の本体は、投入の入口と登録のステップにある。ここは、送る前に分かる誤りを入力欄で知らせるためのもので、
// 断りを置き換えない。PRの番号の範囲は登録のステップの判定(正の安全な整数)に合わせ、
// 契約テストが同じ入力の列で突き合わせる。

import { parseRepoRef } from "./manualIntake.ts";

export type PrReviewForm = {
  /** `owner/repo`の形。候補から選ぶか、自由に入力する。空なら、PRのURLから読む。 */
  readonly repo: string;
  /** PRの番号、またはPRのURL。 */
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

/** 画面を開いたときの入力欄。リポジトリは、候補があっても空から始める。投入先を取り違えないためである。 */
export const EMPTY_PR_REVIEW_FORM: PrReviewForm = { repo: "", pr: "" };

const DIGITS = /^[0-9]+$/;

/** URLの先頭。スキームとホストの大文字小文字は区別しない。userinfoとポートは受けない。 */
const URL_PREFIX = /^(?:https?:\/\/)?(?:www\.)?github\.com\//i;

/** 先頭より後ろ。`pull`は小文字だけを受ける。番号の後ろは、`/`、`?`、`#`のどれかで始まる続きだけを許す。 */
const URL_PULL = /^([^/\s?#]+)\/([^/\s?#]+)\/pull\/([0-9]+)(?:[/?#].*)?$/;

type UrlTarget = {
  readonly owner: string;
  readonly repo: string;
  readonly digits: string;
};

function parsePrUrl(text: string): UrlTarget | null {
  const prefix = URL_PREFIX.exec(text);
  if (prefix === null) {
    return null;
  }
  const match = URL_PULL.exec(text.slice(prefix[0].length));
  const owner = match?.[1];
  const repo = match?.[2];
  const digits = match?.[3];
  if (owner === undefined || repo === undefined || digits === undefined) {
    return null;
  }
  const ref = parseRepoRef(`${owner}/${repo}`);
  return ref === null ? null : { ...ref, digits };
}

/** 桁だけの文字列を、1以上の安全な整数として読む。範囲の外は`null`を返す。 */
function parsePrNumber(digits: string): number | null {
  const value = Number(digits);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function sameRepo(
  left: { readonly owner: string; readonly repo: string },
  right: { readonly owner: string; readonly repo: string },
): boolean {
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase()
  );
}

/**
 * 入力欄の値を、書き込みの入力にする。誤りは、次の順で最初の1つを返す。
 * リポジトリ欄が入力済みで形が不正、PR欄が空、PR欄が読めない、数字だけなのにリポジトリ欄が空、
 * URLのリポジトリが入力済みのリポジトリ欄と食い違う、の順である。
 * URLでリポジトリ欄が空なら、URLのリポジトリを使う。リポジトリ欄と一致するときは、欄の値を送る。
 * 食い違いは、大文字小文字を区別しない。
 */
export function buildPrReviewInput(form: PrReviewForm): PrReviewBuild {
  const repoText = form.repo.trim();
  const field = repoText === "" ? null : parseRepoRef(repoText);
  if (repoText !== "" && field === null) {
    return { ok: false, problem: "repo_invalid" };
  }
  const prText = form.pr.trim();
  if (prText === "") {
    return { ok: false, problem: "pr_empty" };
  }

  if (DIGITS.test(prText)) {
    const prNumber = parsePrNumber(prText);
    if (prNumber === null) {
      return { ok: false, problem: "pr_invalid" };
    }
    return field === null
      ? { ok: false, problem: "repo_invalid" }
      : { ok: true, input: { ...field, prNumber } };
  }

  const url = parsePrUrl(prText);
  const prNumber = url === null ? null : parsePrNumber(url.digits);
  if (url === null || prNumber === null) {
    return { ok: false, problem: "pr_invalid" };
  }
  if (field === null) {
    return {
      ok: true,
      input: { owner: url.owner, repo: url.repo, prNumber },
    };
  }
  return sameRepo(field, url)
    ? { ok: true, input: { ...field, prNumber } }
    : { ok: false, problem: "pr_url_repo_mismatch" };
}

const PROBLEM_MESSAGES: Readonly<Record<PrReviewProblem, string>> = {
  repo_invalid:
    "リポジトリは「オーナー名/リポジトリ名」の形で入力してください。",
  pr_empty: "PRの番号またはURLを入力してください。",
  pr_invalid:
    "PRの番号は1以上の整数で、URLはGitHubのPRのURLで入力してください。",
  pr_url_repo_mismatch:
    "URLのリポジトリが、リポジトリ欄と異なります。どちらかを直してください。",
};

export function describePrReviewProblem(problem: PrReviewProblem): string {
  return PROBLEM_MESSAGES[problem];
}
