// Issueの取得(claim)の後処理のうち、`poll_issues`と`manual_intake_register`が
// 共有するもの。

import type { addNoticeUnlessUnresolved } from "./db.ts";
import { type Logger, maskSecrets } from "./log.ts";

/**
 * assigneeを設定できなかったことをnoticeに残す。記録に失敗しても例外にしない。
 * ラベルは既に外れているので、ここで例外にすると、ラベルも作業項目も無いIssueが残る。
 * 設定できない主な原因は、Factoryのユーザーがリポジトリのpush権限を持たないことである。
 * GitHubは権限の無いユーザーへのassigneeの追加を、成功の応答のまま無視する。
 * 本文は対象とユーザーだけで決まるので、同じ本文の未解決のnoticeがあれば追加されない。
 */
export async function recordAssigneeMissing(
  target: string,
  viewerLogin: string,
  addNotice: typeof addNoticeUnlessUnresolved,
  log: Logger,
): Promise<void> {
  try {
    await addNotice({
      kind: "claim_assignee_missing",
      message: `${target}: assigneeに${viewerLogin}を設定できませんでしたが、作業は続けます。${viewerLogin}がこのリポジトリのpush権限を持つcollaboratorか確かめてください`,
    });
  } catch (err) {
    log.warn("claim_assignee_missing notice could not be recorded", {
      target,
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
  }
}

/**
 * ほかが先にトリガーラベルを外したことをnoticeに残す。記録に失敗しても例外にしない。
 * 本文は対象と理由だけで決まるので、同じ本文の未解決のnoticeがあれば追加されない。
 */
export async function recordClaimRaceLost(
  target: string,
  reason: string,
  addNotice: typeof addNoticeUnlessUnresolved,
  log: Logger,
): Promise<void> {
  try {
    await addNotice({
      kind: "claim_race_lost",
      message: `${target}: ${reason}`,
    });
  } catch (err) {
    log.warn("claim_race_lost notice could not be recorded", {
      target,
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
  }
}
