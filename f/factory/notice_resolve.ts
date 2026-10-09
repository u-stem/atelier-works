// Factory Consoleから通知(`factory.notices`)を1件だけ解決済みにするscript。
//
// 解決者は、呼び出し側が渡す文字列ではなく、ジョブのWindmill実行文脈から導く
// (`deriveApprover`)。導けないときは何も変えずに拒否する。
// 一括の解決は作らない。内容を確かめずに複数の通知を消せないようにするため。
// 設定や権限の問題を示す種類(`UNRESOLVABLE_NOTICE_KINDS`)は解決できない。
// 同じ通知への重複した呼び出しは、解決済みとして成功を返す。

import { deriveApprover } from "./lib/approver.ts";
import {
  isNoticeResolvable,
  UNRESOLVABLE_NOTICE_KINDS,
} from "./lib/console_support.ts";
import { getNoticeById, resolveNoticeIfUnresolved } from "./lib/db.ts";
import type { Notice } from "./lib/types.ts";

export type NoticeResolveResult = {
  readonly ok: true;
  readonly status: "resolved" | "already_resolved";
  readonly notice_id: number;
};

/** `resolveNotice`が使う外部の操作。テストでは差し替える。 */
export type NoticeResolveDeps = {
  readonly deriveApprover: () => string;
  readonly getNoticeById: (id: number) => Promise<Notice | null>;
  readonly resolveNoticeIfUnresolved: (
    id: number,
    kind: string,
    resolvedBy: string,
  ) => Promise<boolean>;
};

/**
 * 通知`noticeId`を解決済みにする。
 * `noticeId`が正の整数でないとき、解決者を導けないとき、通知が無いとき、
 * 解決できない種類のときは例外を投げる。
 * 解決済みなら何も変えずに`already_resolved`を返す。
 * 更新が行を変えなかったときは読み直し、同時に別の呼び出しが解決していれば
 * `already_resolved`、通知が消えていたり未解決のままなら例外を投げる。
 */
export async function resolveNotice(
  noticeId: number,
  deps: NoticeResolveDeps,
): Promise<NoticeResolveResult> {
  if (!Number.isInteger(noticeId) || noticeId <= 0) {
    throw new Error(
      `notice_resolve: "notice_id" must be a positive integer (got ${String(noticeId)})`,
    );
  }
  const approver = deps.deriveApprover();

  const notice = await deps.getNoticeById(noticeId);
  if (notice === null) {
    throw new Error(`notice_resolve: no notice with id ${String(noticeId)}`);
  }
  if (!isNoticeResolvable(notice.kind)) {
    throw new Error(
      `notice_resolve: notice ${String(noticeId)} (${notice.kind}) cannot be resolved from the Console`,
    );
  }
  if (notice.resolved) {
    return { ok: true, status: "already_resolved", notice_id: noticeId };
  }

  const resolved = await deps.resolveNoticeIfUnresolved(
    noticeId,
    notice.kind,
    approver,
  );
  if (resolved) {
    return { ok: true, status: "resolved", notice_id: noticeId };
  }

  const current = await deps.getNoticeById(noticeId);
  if (current === null) {
    throw new Error(
      `notice_resolve: notice ${String(noticeId)} disappeared mid-resolution`,
    );
  }
  if (current.resolved) {
    return { ok: true, status: "already_resolved", notice_id: noticeId };
  }
  throw new Error(
    `notice_resolve: notice ${String(noticeId)} was not resolved`,
  );
}

/** Consoleの通知を1件解決する。解決者はジョブの実行文脈から導く。 */
export async function main(notice_id: number): Promise<NoticeResolveResult> {
  return await resolveNotice(notice_id, {
    deriveApprover: () =>
      deriveApprover({
        WM_USERNAME: process.env.WM_USERNAME,
        WM_EMAIL: process.env.WM_EMAIL,
      }),
    getNoticeById: (id) => getNoticeById(id),
    resolveNoticeIfUnresolved: (id, kind, resolvedBy) =>
      resolveNoticeIfUnresolved(
        id,
        kind,
        resolvedBy,
        UNRESOLVABLE_NOTICE_KINDS,
      ),
  });
}
