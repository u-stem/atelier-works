// `factory_repo_id`を、`factory_repo`の取得の前にGitHubの現在のリポジトリIDと照合する。
// Factory自身のcloneを使うすべてのフローが、`ensureVerifiedFactoryClone`を通して取得する。
// オーナーが改名して別の人がその名前を取得すると、名前のURLは別のリポジトリを指す。
// その内容を、秘密値を持つworkspaceへ反映したり、Claudeに読ませたりしないための照合である。
// I/Oは依存として受け取り、テストでは差し替える。

import { GitHubHttpError, parseGitHubRepoUrl } from "./github.ts";
import type { FactoryConfig, NoticeRecord } from "./types.ts";
import {
  type EnsureFactoryCloneOptions,
  type EnsureFactoryCloneResult,
  ensureFactoryClone,
} from "./workspace.ts";

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
  return `${repository}: GitHubの現在のIDが${String(actualId)}で、設定のfactory_repo_idの${String(expectedId)}と食い違うため、factory_repoを取得せずに止めました。オーナーが改名して別の人がその名前を取得した可能性があります。factory_configのfactory_repoとfactory_repo_idを見直してください`;
}

/**
 * リポジトリが見つからないnoticeの本文。
 * 改名か削除でほぼ恒久なので、人が設定を見直すまで同じ状況が続く。
 */
export function factoryRepoNotFoundMessage(
  repository: string,
  expectedId: number,
): string {
  return `${repository}: GitHubにこのリポジトリが見つかりません(設定のfactory_repo_idは${String(expectedId)})。リポジトリが削除されたか、オーナーが改名した可能性があるため、factory_repoを取得せずに止めました。factory_configのfactory_repoとfactory_repo_idを見直してください`;
}

/**
 * `factory_repo`からオーナーとリポジトリ名を読めないnoticeの本文。
 * URLは認証情報を含みうるので、本文に載せない。
 */
export function factoryRepoUnreadableMessage(expectedId: number): string {
  return `factory_repoのURLからオーナーとリポジトリ名を読めず、設定のfactory_repo_idの${String(expectedId)}を照合できないため、factory_repoを取得せずに止めました。factory_configのfactory_repoをhttps://github.com/<owner>/<repo>の形に直してください`;
}

/**
 * `factory_repo_id`と、GitHubの現在のIDが食い違うなどで、照合できなかったときのエラー。
 * 食い違い、リポジトリが無い(404)、URLを読めない場合に投げる。
 * 本文は、要対応のnoticeと同じである。
 * 一時的でありうる取得の失敗(5xx、レート制限、認証、通信断)は、これにせず、元の例外を投げる。
 */
export class FactoryRepoIdMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FactoryRepoIdMismatchError";
  }
}

export type FactoryRepoVerifyDeps = {
  readonly getRepositoryId: (owner: string, repo: string) => Promise<number>;
  readonly addNotice: (record: NoticeRecord) => Promise<unknown>;
};

/**
 * `factory_repo_id`があるときだけ、GitHubの現在のIDと照合する。
 * `factory_repo_id`が無ければ、名前だけで動くので、取得せずに返す。
 * 食い違い、リポジトリが無い(404)、URLを読めない場合は、noticeを残して`FactoryRepoIdMismatchError`を投げる。
 * どれも設定か改名の問題でほぼ恒久で、人が`factory_repo`を見直す操作がある。
 * それ以外の取得の失敗は、noticeを残さず、元の例外を投げる。一時的な障害でありうるので、呼び出し側のジョブの失敗にする。
 * noticeの記録が失敗しても、`FactoryRepoIdMismatchError`を隠さない。
 */
export async function verifyFactoryRepoId(
  config: Pick<FactoryConfig, "factory_repo" | "factory_repo_id">,
  deps: FactoryRepoVerifyDeps,
): Promise<void> {
  const expectedId = config.factory_repo_id;
  if (expectedId === undefined) {
    return;
  }
  let ref: { readonly owner: string; readonly repo: string };
  try {
    ref = parseGitHubRepoUrl(config.factory_repo);
  } catch {
    // 元のURLは認証情報を含みうるので、例外をそのまま使わない。
    await rejectWithNotice(factoryRepoUnreadableMessage(expectedId), deps);
    return;
  }
  const repository = `${ref.owner}/${ref.repo}`;
  let actualId: number;
  try {
    actualId = await deps.getRepositoryId(ref.owner, ref.repo);
  } catch (err) {
    if (err instanceof GitHubHttpError && err.status === 404) {
      await rejectWithNotice(
        factoryRepoNotFoundMessage(repository, expectedId),
        deps,
      );
    }
    throw err;
  }
  if (actualId !== expectedId) {
    await rejectWithNotice(
      factoryRepoIdMismatchMessage(repository, expectedId, actualId),
      deps,
    );
  }
}

async function rejectWithNotice(
  message: string,
  deps: FactoryRepoVerifyDeps,
): Promise<never> {
  try {
    await deps.addNotice({ kind: FACTORY_REPO_ID_MISMATCH_KIND, message });
  } catch {
    // noticeを残せなくても、照合に落ちたことは呼び出し側のエラーで伝わる。
  }
  throw new FactoryRepoIdMismatchError(message);
}

export type EnsureVerifiedFactoryCloneDeps = FactoryRepoVerifyDeps & {
  /** 省略すると`ensureFactoryClone`。テストで差し替える。 */
  readonly ensureClone?: (
    opts: EnsureFactoryCloneOptions,
  ) => Promise<EnsureFactoryCloneResult>;
};

/**
 * `factory_repo_id`を照合してから、`config.factory_repo`のcloneを用意する。
 * 照合に落ちたら、cloneに触れずにエラーを投げる(`verifyFactoryRepoId`を参照)。
 * URLとブランチは`config`から取るので、照合したURLと取得するURLが一致する。
 * `ensureFactoryClone`はfetchの前にoriginをそのURLへ付け替える。
 * 照合とfetchの間の短い時間に、リポジトリが入れ替わる余地は残る。
 */
export async function ensureVerifiedFactoryClone(
  config: Pick<
    FactoryConfig,
    "factory_repo" | "factory_repo_id" | "factory_branch"
  >,
  options: Omit<EnsureFactoryCloneOptions, "repoUrl" | "branch">,
  deps: EnsureVerifiedFactoryCloneDeps,
): Promise<EnsureFactoryCloneResult> {
  await verifyFactoryRepoId(config, deps);
  const ensureClone = deps.ensureClone ?? ensureFactoryClone;
  return ensureClone({
    ...options,
    repoUrl: config.factory_repo,
    branch: config.factory_branch,
  });
}
