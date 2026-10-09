// 新しいサイクルが始まって、承認済みの作業項目を取り消したときの、Issueへのコメント。
// `poll_issues`が、新しいサイクルを始めた後に使う。

import { commentIssue, type GhClient } from "./github.ts";
import { type Logger, maskSecrets } from "./log.ts";

/**
 * 取り消した承認済みの作業項目と、新しいサイクルを伝えるコメントの本文を作る。
 * 副作用は無い。
 * 取り消しの原因は推測せず、新しいサイクルが始まったという事実だけを伝える。
 * 新しいサイクルが失敗することもあるので、承認の依頼が届くとは約束しない。
 * 古い承認についての操作は要らないことを伝える。
 */
export function buildSupersededComment(
  cancelledWorkItemId: number,
  newWorkItemId: number,
): string {
  return [
    `承認済みだった要件定義(work_item_id: ${String(cancelledWorkItemId)})を取り消しました。`,
    `このIssueで新しいサイクル(work_item_id: ${String(newWorkItemId)})が始まったためです。`,
    "新しいサイクルの要件定義には、あらためて承認が必要です。",
    "前の承認について、対応いただく必要はありません。",
  ].join("\n");
}

export type PostSupersededDeps = {
  readonly commentIssue: typeof commentIssue;
};

const defaultDeps: PostSupersededDeps = { commentIssue };

/**
 * 取り消した作業項目ごとに、Issueへコメントを投稿する。
 * 取り消しは、挿入の直後の文で済んでいる。コメントの投稿に失敗しても、
 * 取り消しは戻さず、警告のログに残して次へ進む。
 * 目印は取り消した作業項目のIDと、その`attempt`で決めるので、投稿し直しても重複しない。
 * 取り消しとコメントの間にプロセスが落ちると、コメントは付かない。操作は要らない。
 */
export async function postSupersededComments(
  input: {
    readonly client: GhClient;
    readonly owner: string;
    readonly repo: string;
    readonly issueNumber: number;
    readonly viewerLogin: string;
    readonly newWorkItemId: number;
    readonly superseded: readonly {
      readonly id: number;
      readonly attempt: number;
    }[];
    readonly log: Logger;
  },
  deps: PostSupersededDeps = defaultDeps,
): Promise<void> {
  for (const old of input.superseded) {
    try {
      await deps.commentIssue(
        input.client,
        input.owner,
        input.repo,
        input.issueNumber,
        `issue-superseded-${String(old.attempt)}`,
        old.id,
        buildSupersededComment(old.id, input.newWorkItemId),
        input.viewerLogin,
      );
    } catch (err) {
      input.log.warn("superseded comment could not be posted", {
        cancelled_work_item_id: old.id,
        new_work_item_id: input.newWorkItemId,
        error: maskSecrets(err instanceof Error ? err.message : String(err)),
      });
    }
  }
}
