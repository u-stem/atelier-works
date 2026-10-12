// 保存済みの`owner`/`repo`の作業項目を進める前に、リポジトリのオーナーの数値IDを
// 設定の`owners`の`id`と照合する。
// オーナーが改名して別の人がその名前を取得すると、名前のURLは別のリポジトリを指す。
// 検索の入口の照合(`poll_support.ts`の`gateOwnerId`)を通った後でも、作業項目は
// 名前を保存したまま残るので、承認待ちの間などに入れ替わりうる。
// そのリポジトリのcloneやcheckout、検査コマンドの実行の前に、各準備のステップが呼ぶ。
// I/Oは依存として受け取り、テストでは差し替える。

import { GitHubHttpError } from "./github.ts";
import { OWNER_ID_MISMATCH_KIND } from "./poll_support.ts";
import type { FactoryConfig, NoticeRecord } from "./types.ts";

/**
 * IDが食い違ったnoticeの本文。
 * リポジトリとオーナーと2つのIDだけで決まるので、同じ食い違いが続くあいだは
 * 同じ本文の未解決のnoticeが重ならない。
 */
export function repoOwnerIdMismatchMessage(
  repository: string,
  ownerName: string,
  expectedId: number,
  actualId: number,
): string {
  return `${repository}: リポジトリのオーナーの現在のIDが${String(actualId)}で、設定のownersの${ownerName}のID${String(expectedId)}と食い違うため、リポジトリを取得せずに作業を止めました。オーナーが改名して別の人がその名前を取得した可能性があります。factory_configのownersの名前かidを見直してください`;
}

/**
 * リポジトリが見つからないnoticeの本文。
 * 削除や改名でほぼ恒久なので、人が設定を見直すまで同じ状況が続く。
 */
export function repoOwnerNotFoundMessage(
  repository: string,
  ownerName: string,
  expectedId: number,
): string {
  return `${repository}: GitHubにこのリポジトリが見つかりません(設定のownersの${ownerName}のIDは${String(expectedId)})。リポジトリの削除、オーナーの改名、PATの権限の喪失のいずれかの可能性があるため、リポジトリを取得せずに作業を止めました。privateリポジトリでは、PATがアクセスを失うと401でなく404が返ることがあります。factory_configのownersの名前とidを見直してください`;
}

/**
 * 作業項目の状態の注記に残す、IDの食い違いの理由。
 * 記録する理由は英語のまま保ち、表示するときだけ訳す(`describeReason`)。
 */
export function repoOwnerIdMismatchReason(
  repository: string,
  expectedId: number,
  actualId: number,
): string {
  return `repository owner id differs from factory_config owners: ${repository} (expected ${String(expectedId)}, actual ${String(actualId)})`;
}

/** 作業項目の状態の注記に残す、リポジトリが見つからない理由。 */
export function repoOwnerNotFoundReason(
  repository: string,
  expectedId: number,
): string {
  return `repository not found while checking the owner id in factory_config owners: ${repository} (expected ${String(expectedId)})`;
}

export type RepoOwnerGateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export type RepoOwnerGateDeps = {
  readonly getRepositoryOwnerId: (
    owner: string,
    repo: string,
  ) => Promise<number>;
  readonly addNotice: (record: NoticeRecord) => Promise<unknown>;
};

/**
 * `owner`と同じ名前(大文字と小文字を区別しない)の`owners`の要素が`id`を持つときだけ、
 * `GET repos/{owner}/{repo}`のオーナーのIDと照合する。
 * `id`が無いときと、`owners`に同じ名前が無いとき(`factory_repo`だけで許されるリポジトリ)は、
 * 名前だけで動くので、取得せずに通す。`factory_repo`は`factory_repo_id`が別に照合する。
 * 食い違いと、リポジトリが無い(404)ときは、noticeを残して理由つきで止める。
 * どちらも改名か削除でほぼ恒久で、人が`owners`を見直す操作がある。
 * 404以外の取得の失敗(401、5xx、レート制限、通信断)は、noticeを残さず元の例外を投げる。
 * 一時的な障害でありうるので、呼び出し側のジョブの失敗にして、検知を弱めない。
 * noticeの記録が失敗しても、止める結果を隠さない。
 * 取得は1回だけである。
 */
export async function verifyRepoOwnerId(
  config: Pick<FactoryConfig, "owners">,
  owner: string,
  repo: string,
  deps: RepoOwnerGateDeps,
): Promise<RepoOwnerGateResult> {
  const configured = config.owners.find(
    (candidate) => candidate.name.toLowerCase() === owner.toLowerCase(),
  );
  const expectedId = configured?.id;
  if (configured === undefined || expectedId === undefined) {
    return { ok: true };
  }
  const repository = `${owner}/${repo}`;
  let actualId: number;
  try {
    actualId = await deps.getRepositoryOwnerId(owner, repo);
  } catch (err) {
    if (err instanceof GitHubHttpError && err.status === 404) {
      await recordNotice(
        repoOwnerNotFoundMessage(repository, configured.name, expectedId),
        deps,
      );
      return {
        ok: false,
        reason: repoOwnerNotFoundReason(repository, expectedId),
      };
    }
    throw err;
  }
  if (actualId === expectedId) {
    return { ok: true };
  }
  await recordNotice(
    repoOwnerIdMismatchMessage(
      repository,
      configured.name,
      expectedId,
      actualId,
    ),
    deps,
  );
  return {
    ok: false,
    reason: repoOwnerIdMismatchReason(repository, expectedId, actualId),
  };
}

async function recordNotice(
  message: string,
  deps: RepoOwnerGateDeps,
): Promise<void> {
  try {
    await deps.addNotice({ kind: OWNER_ID_MISMATCH_KIND, message });
  } catch {
    // noticeを残せなくても、止めたことは呼び出し側の終端と作業項目の注記で伝わる。
  }
}
