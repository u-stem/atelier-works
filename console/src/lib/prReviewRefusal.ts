// PRレビューの断りの符号を、日本語の固定文にする。
// 断りは2か所で起きる。投入の入口は、フローを起動する前に断る。何も投入していないことは、画面の見出しが伝える。
// 登録のステップは、フローが動いた後に断る。文の末尾で、フローは動いたがレビューは始まっていないことを伝える。
// 文は符号だけから引き、入力の文字列(オーナー、リポジトリ)を含めない。隠れた文字を画面に出さないためである。
// `repo_not_allowed`だけは、2か所で意味が違うので、別の文にする。
// 入口では入力したリポジトリ、ステップではPRの正しい名前(改名の後の名前)が許可されていない。

import type {
  PrReviewRegisterRefusalReason,
  PrReviewSubmitRefusalReason,
} from "../api/guards/writeResults.ts";

const NOT_STARTED = "フローは動きましたが、レビューは始まっていません。";

/** 2か所で同じ意味を持つ文。 */
const INVALID_PR_NUMBER =
  "PRの番号が正しくありません。1以上の整数で入力してください。";

const SUBMIT_REFUSALS: Readonly<Record<PrReviewSubmitRefusalReason, string>> = {
  invalid_owner:
    "オーナー名が正しくありません。英数字で始め、英数字と「.」「_」「-」だけで書いてください。",
  invalid_repo:
    "リポジトリ名が正しくありません。英数字で始め、英数字と「.」「_」「-」だけで書いてください。",
  invalid_pr_number: INVALID_PR_NUMBER,
  repo_not_allowed:
    "このリポジトリは許可されていません。候補から選ぶか、許可の設定を確かめてください。",
  actor_unknown:
    "操作した人を特定できませんでした。ログインし直してから、もう一度試してください。",
  already_reviewing:
    "このPRのレビューは進行中です。作業項目の一覧から確認してください。",
};

const REGISTER_REFUSALS: Readonly<
  Record<PrReviewRegisterRefusalReason, string>
> = {
  invalid_pr_number: `${INVALID_PR_NUMBER}${NOT_STARTED}`,
  repo_not_allowed: `PRの正しいリポジトリ名(改名の後の名前)が許可されていません。${NOT_STARTED}`,
  pr_not_found: `PRが見つかりません。番号とリポジトリが合っているか確かめてください。${NOT_STARTED}`,
  pr_closed: `PRはすでに閉じています。開いているPRを指定してください。${NOT_STARTED}`,
  fork_head: `PRの変更がフォークのブランチにあるため、レビューできません。このリポジトリ内のブランチのPRだけを受け付けます。${NOT_STARTED}`,
  owner_mismatch: `リポジトリの所有者が、設定で許可した所有者と一致しないため、レビューできません。${NOT_STARTED}`,
  repo_mismatch: `PRのリポジトリが、入力したリポジトリと一致しません。改名や移管の後の名前で入力してください。${NOT_STARTED}`,
  // 進行中のレビューが残るので、始まっていないのは新しいレビューだけである。末尾の定型文は使わない。
  already_reviewing:
    "このPRのレビューは進行中です。新しいレビューは始めていません。作業項目の一覧から確認してください。",
};

/** 投入の入口の断りを、画面に出す日本語の文にする。 */
export function describePrReviewSubmitRefusal(
  reason: PrReviewSubmitRefusalReason,
): string {
  return SUBMIT_REFUSALS[reason];
}

/** 登録のステップの断りを、画面に出す日本語の文にする。 */
export function describePrReviewRegisterRefusal(
  reason: PrReviewRegisterRefusalReason,
): string {
  return REGISTER_REFUSALS[reason];
}
