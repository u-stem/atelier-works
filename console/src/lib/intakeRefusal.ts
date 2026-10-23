// 手動投入を断った理由(`manual_intake_submit`が返す符号)を、日本語の固定文にする。
// 理由に入力の文字列は含まれないので、文にも入力は入らない。
// 断りは、フローを起動する前に起きる。Issueも作業項目も作られていない。

import type { ManualIntakeRefusalReason } from "../api/guards/writeResults.ts";

const NOTHING_SUBMITTED = "投入していません。";

const REFUSALS: Readonly<Record<ManualIntakeRefusalReason, string>> = {
  invalid_owner:
    "オーナー名が正しくありません。英数字で始め、英数字と「.」「_」「-」だけで書いてください。",
  invalid_repo:
    "リポジトリ名が正しくありません。英数字で始め、英数字と「.」「_」「-」だけで書いてください。",
  repo_not_allowed:
    "このリポジトリは投入先として許可されていません。候補から選ぶか、許可の設定を確かめてください。",
  empty_title: "題名が空です。題名を入力してください。",
  title_too_long: "題名が長すぎます。256字までにしてください。",
  invalid_title_chars:
    "題名に使えない文字があります。改行、タブ、制御文字、文字の向きを変える記号は使えません。",
  empty_body: "目的が空です。目的を入力してください。",
  invalid_body_chars:
    "目的か受入基準に使えない文字があります。改行とタブ以外の制御文字と、文字の向きを変える記号は使えません。",
  body_too_long:
    "目的と受入基準が長すぎます。Issueの本文に組み立てた後で、65,536字までにしてください。",
  actor_unknown:
    "操作した人を特定できませんでした。ログインし直してから、もう一度試してください。",
};

/** 断りの理由を、画面に出す日本語の文にする。末尾に、何も投入していないことを添える。 */
export function describeIntakeRefusal(
  reason: ManualIntakeRefusalReason,
): string {
  return `${REFUSALS[reason]}${NOTHING_SUBMITTED}`;
}
