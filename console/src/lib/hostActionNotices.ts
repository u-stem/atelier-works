// ホスト側の作業を知らせる、未解決の通知の数え方。
// 要約の帯と反映の節が同じ数を使い、記録の印(作業が済んでも残る)に頼らず、残っている作業を示す。

import type { ConsoleSummary } from "../api/guards/summary.ts";

/** ホスト側の作業を知らせる未解決の通知の種類。`f/factory/lib/auto_retry_reasons.ts`と同じ値にする。 */
export const HOST_ACTION_NOTICE_KIND = "host_action_required";

/** summaryの未解決の通知から数えた、ホスト側の作業の通知。 */
export type HostActionNotices = {
  /** 一覧にある通知の数。 */
  readonly count: number;
  /** 一覧が未解決の通知のすべてか。上限で切れていれば偽で、`count`は下限になる。 */
  readonly complete: boolean;
  /** 最も新しい通知のid。無ければ`null`。 */
  readonly firstNoticeId: number | null;
};

export function hostActionNotices(_summary: ConsoleSummary): HostActionNotices {
  return { count: 0, complete: true, firstNoticeId: null };
}

/** 残っている作業の有無を言い切れるか。通知があるか、一覧が全件のときに言い切れる。 */
export function isHostActionKnown(_notices: HostActionNotices): boolean {
  return false;
}
