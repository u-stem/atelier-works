// 承認を省く進め方の作業項目を通常の進め方に戻したとき、Issueに知らせるコメント。
// 戻す更新そのものは`lib/db.ts`の、要件定義の生成へ移す更新が行う。
// 実装の完了(`steps/implement_finish.ts`)とPR修正の完了(`steps/pr_fix_finish.ts`)が使う。
// 入出力は注入された依存を通してだけ行う。

/** 進め方を通常に戻したことをIssueに伝えるコメントの目印の種類。作業項目ごとに1件だけ付く。 */
export const PROFILE_UPGRADED_COMMENT_KIND = "profile-upgraded";

/** 進め方を通常に戻した原因。 */
export type ProfileUpgradeCause = "requirements_gap" | "protected_paths";

/**
 * 進め方を通常に戻したことをIssueに伝えるかを返す。
 * 戻す前の進め方が通常のときは、何も変わらないので伝えない。
 * 前の進め方は、呼び出し側が戻す前に読んだ作業項目の値を渡す。
 * 戻す更新は、状態と`flow_job_id`が読んだ時点のままのときだけ書くので、その間に進め方が変わることは無い。
 */
export function shouldCommentProfileUpgrade(previousProfile: string): boolean {
  return previousProfile !== "standard";
}

/** 進め方を通常に戻したことを伝えるコメントの本文を返す。 */
export function buildProfileUpgradedComment(input: {
  readonly workItemId: number;
  readonly previousProfile: string;
  readonly cause: ProfileUpgradeCause;
}): string {
  const cause =
    input.cause === "protected_paths"
      ? "承認なしの実装では保護パスを変更できないのに、保護パスの変更が要ると分かったためです。"
      : "承認なしの実装で、Issueの本文だけでは要件が足りないと分かったためです。";
  return [
    `進め方を${input.previousProfile}から通常の進め方(standard)に切り替えました(work_item_id: ${String(input.workItemId)})。`,
    cause,
    "要件定義を作り直し、承認を依頼します。",
  ].join("\n");
}

/**
 * 進め方を通常に戻したことをIssueに伝える。戻す前の進め方が通常のときは何もしない。
 * コメントの失敗は、戻した結果を変えないので、警告に残して続ける。
 * 目印は作業項目ごとに1件なので、投稿し直しても重複しない。
 */
export async function postProfileUpgradedComment(
  input: {
    readonly previousProfile: string;
    readonly workItemId: number;
    readonly cause: ProfileUpgradeCause;
  },
  deps: {
    readonly comment: (kind: string, body: string) => Promise<void>;
    readonly warn: (message: string) => void;
  },
): Promise<"posted" | "skipped" | "failed"> {
  if (!shouldCommentProfileUpgrade(input.previousProfile)) return "skipped";
  try {
    await deps.comment(
      PROFILE_UPGRADED_COMMENT_KIND,
      buildProfileUpgradedComment(input),
    );
    return "posted";
  } catch {
    deps.warn("the profile upgrade comment could not be posted");
    return "failed";
  }
}
