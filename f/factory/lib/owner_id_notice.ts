// オーナーの数値IDの照合で出すnoticeの種類と本文。
// 通信もファイルも持たず、`github.ts`に届かない。定期ジョブ用workerのscriptも読める。

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
