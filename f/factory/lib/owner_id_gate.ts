// オーナーの数値IDの照合。
// fsにもサブプロセスにも触れないモジュールだけに依存するので、定期ジョブ用workerで動く収集から読める。
// `poll_support.ts`が再エクスポートするので、既存のimport元はそのまま動く。

import { GitHubHttpError } from "./gh_errors.ts";
import type { NoticeRecord } from "./types.ts";

/** オーナーの数値IDが食い違ったことを知らせるnoticeの種類。 */
export const OWNER_ID_MISMATCH_KIND = "owner_id_mismatch";

/**
 * 数値IDが食い違ったオーナーのnoticeの本文。
 * オーナーと2つのIDだけで決まるので、同じ食い違いが続くあいだは
 * 同じ本文の未解決のnoticeが重ならない。
 */
export function ownerIdMismatchMessage(
  name: string,
  expectedId: number,
  actualId: number,
): string {
  return `${name}: GitHubの現在のIDが${String(actualId)}で、設定のID${String(expectedId)}と食い違うため、このオーナーの検索を飛ばしました。オーナーが改名して別の人がその名前を取得した可能性があります。factory_configのownersを見直してください`;
}

/**
 * 名前のアカウントが見つからないオーナーのnoticeの本文。
 * 改名か削除でほぼ恒久なので、人が`owners`を見直すまで同じ状況が続く。
 */
export function ownerNotFoundMessage(name: string, expectedId: number): string {
  return `${name}: GitHubにこの名前のアカウントが見つかりません(設定のID${String(expectedId)})。オーナーが改名または削除された可能性があるため、このオーナーの検索を飛ばしました。factory_configのownersの名前とidを見直してください`;
}

export type OwnerIdGateDeps = {
  readonly getAccountId: (name: string) => Promise<number>;
  readonly recordFailure: (step: string, err: unknown) => Promise<void>;
  readonly addNotice: (record: NoticeRecord) => Promise<unknown>;
};

/**
 * `id`を持つオーナーだけ、GitHubの現在のIDと照合し、検索してよいかを返す。
 * `id`の無いオーナーは名前だけで動かすので、取得せずに`true`を返す。
 * 食い違いと取得の失敗は、検索を飛ばす(`false`)うえで、失敗として記録する。
 * noticeは、食い違いと、名前のアカウントが無い(404)ときに残す。
 * どちらも改名か削除でほぼ恒久で、人が`owners`を見直す操作がある。
 * 5xxやレート制限は一時的な障害でありうるので、失敗の記録だけにする。
 * noticeの記録が失敗してもポーリング全体を止めない。
 */
export async function gateOwnerId(
  owner: { readonly name: string; readonly id?: number },
  deps: OwnerIdGateDeps,
): Promise<boolean> {
  const expectedId = owner.id;
  if (expectedId === undefined) {
    return true;
  }
  const step = `verify_owner_id:${owner.name}`;
  let actualId: number;
  try {
    actualId = await deps.getAccountId(owner.name);
  } catch (err) {
    if (err instanceof GitHubHttpError && err.status === 404) {
      await recordOwnerNotice(
        step,
        ownerNotFoundMessage(owner.name, expectedId),
        deps,
      );
    } else {
      await deps.recordFailure(step, err);
    }
    return false;
  }
  if (actualId === expectedId) {
    return true;
  }
  await recordOwnerNotice(
    step,
    ownerIdMismatchMessage(owner.name, expectedId, actualId),
    deps,
  );
  return false;
}

async function recordOwnerNotice(
  step: string,
  message: string,
  deps: OwnerIdGateDeps,
): Promise<void> {
  await deps.recordFailure(step, new Error(message));
  try {
    await deps.addNotice({ kind: OWNER_ID_MISMATCH_KIND, message });
  } catch (err) {
    await deps.recordFailure(`${step}:notice`, err);
  }
}
