// `factory_repo_id`を、`factory_repo`の取得の前にGitHubの現在のリポジトリIDと照合する。
// `self_update`が、取得と反映より前に呼ぶ。
// オーナーが改名して別の人がその名前を取得すると、名前のURLは別のリポジトリを指す。
// その内容を、秘密値を持つworkspaceへ反映しないための照合である。
// I/Oは依存として受け取り、テストでは差し替える。

import { GitHubHttpError, parseGitHubRepoUrl } from "./github.ts";
import type { FactoryConfig, NoticeRecord } from "./types.ts";

/** `factory_repo`のIDを照合できないことを知らせるnoticeの種類。 */
export const FACTORY_REPO_ID_MISMATCH_KIND = "factory_repo_id_mismatch";

/**
 * IDが食い違ったnoticeの本文。
 * リポジトリと2つのIDだけで決まるので、同じ食い違いが続くあいだは
 * 同じ本文の未解決のnoticeが重ならない。
 */
export function factoryRepoIdMismatchMessage(
  repository: string,
  expectedId: number,
  actualId: number,
): string {
  return `${repository}: GitHubの現在のIDが${String(actualId)}で、設定のfactory_repo_idの${String(expectedId)}と食い違うため、自己更新で反映しませんでした。オーナーが改名して別の人がその名前を取得した可能性があります。factory_configのfactory_repoとfactory_repo_idを見直してください`;
}

/**
 * リポジトリが見つからないnoticeの本文。
 * 改名か削除でほぼ恒久なので、人が設定を見直すまで同じ状況が続く。
 */
export function factoryRepoNotFoundMessage(
  repository: string,
  expectedId: number,
): string {
  return `${repository}: GitHubにこのリポジトリが見つかりません(設定のfactory_repo_idは${String(expectedId)})。リポジトリが削除されたか、オーナーが改名した可能性があるため、自己更新で反映しませんでした。factory_configのfactory_repoとfactory_repo_idを見直してください`;
}

/**
 * `factory_repo`からオーナーとリポジトリ名を読めないnoticeの本文。
 * URLは認証情報を含みうるので、本文に載せない。
 */
export function factoryRepoUnreadableMessage(expectedId: number): string {
  return `factory_repoのURLからオーナーとリポジトリ名を読めず、設定のfactory_repo_idの${String(expectedId)}を照合できないため、自己更新で反映しませんでした。factory_configのfactory_repoをhttps://github.com/<owner>/<repo>の形に直してください`;
}

export type FactoryRepoGateDeps = {
  readonly getRepositoryId: (owner: string, repo: string) => Promise<number>;
  readonly recordFailure: (step: string, err: unknown) => Promise<void>;
  readonly addNotice: (record: NoticeRecord) => Promise<unknown>;
};

const STEP = "verify_factory_repo_id";

/**
 * `factory_repo_id`があるときだけ、GitHubの現在のIDと照合し、取得してよいかを返す。
 * `factory_repo_id`が無ければ、名前だけで動くので、取得せずに`true`を返す。
 * 食い違い、取得の失敗、URLを読めない場合は、取得を止める(`false`)うえで、失敗として記録する。
 * noticeは、食い違い、リポジトリが無い(404)、URLを読めない場合に残す。
 * どれも設定か改名の問題でほぼ恒久で、人が`factory_repo`を見直す操作がある。
 * 5xx、レート制限、認証の失敗、通信断は一時的でありうるので、失敗の記録だけにする。
 * noticeの記録が失敗しても、例外を投げない。
 */
export async function gateFactoryRepoId(
  config: Pick<FactoryConfig, "factory_repo" | "factory_repo_id">,
  deps: FactoryRepoGateDeps,
): Promise<boolean> {
  const expectedId = config.factory_repo_id;
  if (expectedId === undefined) {
    return true;
  }
  let ref: { readonly owner: string; readonly repo: string };
  try {
    ref = parseGitHubRepoUrl(config.factory_repo);
  } catch {
    // 元のURLは認証情報を含みうるので、例外をそのまま記録しない。
    await recordWithNotice(factoryRepoUnreadableMessage(expectedId), deps);
    return false;
  }
  const repository = `${ref.owner}/${ref.repo}`;
  let actualId: number;
  try {
    actualId = await deps.getRepositoryId(ref.owner, ref.repo);
  } catch (err) {
    if (err instanceof GitHubHttpError && err.status === 404) {
      const message = factoryRepoNotFoundMessage(repository, expectedId);
      await recordWithNotice(message, deps);
    } else {
      await deps.recordFailure(STEP, err);
    }
    return false;
  }
  if (actualId === expectedId) {
    return true;
  }
  const message = factoryRepoIdMismatchMessage(
    repository,
    expectedId,
    actualId,
  );
  await recordWithNotice(message, deps);
  return false;
}

async function recordWithNotice(
  message: string,
  deps: FactoryRepoGateDeps,
): Promise<void> {
  await deps.recordFailure(STEP, new Error(message));
  try {
    await deps.addNotice({ kind: FACTORY_REPO_ID_MISMATCH_KIND, message });
  } catch (err) {
    await deps.recordFailure(`${STEP}:notice`, err);
  }
}
