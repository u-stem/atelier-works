// 保存済みの`owner`/`repo`の作業項目を進める前に、リポジトリのオーナーの数値IDを
// 設定の`owners`の`id`と照合する。
// オーナーが改名して別の人がその名前を取得すると、名前のURLは別のリポジトリを指す。
// 検索の入口の照合(`poll_support.ts`の`gateOwnerId`)を通った後でも、作業項目は
// 名前を保存したまま残るので、承認待ちの間などに入れ替わりうる。
// そのリポジトリのcloneやcheckout、検査コマンドの実行、Issueへの書き込みの前に、各ステップが呼ぶ。
// I/Oは依存として受け取り、テストでは差し替える。

import {
  FactoryRepoIdMismatchError,
  verifyFactoryRepoId,
} from "./factory_repo_gate.ts";
import {
  type GhClient,
  GitHubHttpError,
  getRepositoryId,
  getRepositoryOwnerId,
} from "./github.ts";
import { isFactoryRepo } from "./implement_finish_support.ts";
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
 * `owners`に無いオーナーのリポジトリのnoticeの本文。
 * リポジトリだけで決まるので、同じ状況が続くあいだは同じ本文の未解決のnoticeが重ならない。
 */
export function repoOwnerNotConfiguredMessage(repository: string): string {
  return `${repository}: このオーナーがfactory_configのownersに無く、対象外のため、リポジトリを取得せずに作業を止めました。オーナーを改名した場合は、ownersの名前を新しい名前に直してください。対象にするなら、ownersにオーナーを足してください。ownersを見直して、止めた作業項目を再実行してください`;
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

/** 作業項目の状態の注記に残す、`owners`に無いオーナーの理由。 */
export function repoOwnerNotConfiguredReason(repository: string): string {
  return `repository owner is not in factory_config owners: ${repository}`;
}

/** 作業項目の状態の注記に残す、`factory_repo_id`の照合に落ちた理由。 */
export function factoryRepoIdCheckReason(repository: string): string {
  return `factory repository id check failed: ${repository}`;
}

/** `reason`が、`factory_repo_id`の照合に落ちた理由(`factoryRepoIdCheckReason`)かを返す。 */
export function isFactoryRepoIdCheckReason(reason: string): boolean {
  return reason.startsWith("factory repository id check failed: ");
}

export type RepoOwnerGateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export type RepoOwnerGateDeps = {
  readonly getRepositoryOwnerId: (
    owner: string,
    repo: string,
  ) => Promise<number>;
  /** `factory_repo_id`の照合(`verifyFactoryRepoId`)が使う。`GET repos/{owner}/{repo}`のリポジトリのID。 */
  readonly getRepositoryId: (owner: string, repo: string) => Promise<number>;
  readonly addNotice: (record: NoticeRecord) => Promise<unknown>;
};

/**
 * `client`のGitHub呼び出しと、`addNotice`のnotice記録から、関門の依存を組み立てる。
 * 呼び出し側のステップが同じ配線を重ねて書かないためのものである。
 */
export function repoOwnerGateDeps(
  client: GhClient,
  addNotice: (record: NoticeRecord) => Promise<unknown>,
): RepoOwnerGateDeps {
  return {
    getRepositoryOwnerId: (owner, repo) =>
      getRepositoryOwnerId(client, owner, repo),
    getRepositoryId: (owner, repo) => getRepositoryId(client, owner, repo),
    addNotice,
  };
}

/**
 * 作業項目のリポジトリのオーナーを、設定の`owners`と照合し、先へ進めてよいかを返す。
 * 呼び出しの順に頼らず、この関門自身が閉じる。`isRepoAllowed`を呼ばないステップにも使うため。
 *
 * - リポジトリが`factory_repo`と一致し、`factory_repo_id`があるときは、先にそのIDを照合する(`verifyFactoryRepoId`)。
 *   食い違い、リポジトリが無い(404)ときは、`factory_repo_id_mismatch`のnoticeを残して理由つきで止める。
 *   cloneを開かないステップ(Issueの作成、Issue化の提案)は、`openFactoryClone`の照合を通らないので、ここで行う。
 *   cloneを開くステップでは、同じ照合が重なる。取得が1回増えるだけなので許容する。
 * - `owner`と同じ名前(大文字と小文字を区別しない)の`owners`の要素が無いときは、
 *   リポジトリが`factory_repo`と一致する場合だけ通す。
 *   それ以外は、noticeを残して理由つきで止める。`owners`に無いオーナーは対象外のためである。
 * - 要素が`id`を持たないときは、名前だけで動くので、取得せずに通す。
 * - 要素が`id`を持つときは、`GET repos/{owner}/{repo}`のオーナーのIDと照合する。
 *   食い違いと、リポジトリが無い(404)ときは、noticeを残して理由つきで止める。
 *   どちらも改名か削除でほぼ恒久で、人が`owners`を見直す操作がある。
 * 404以外の取得の失敗(401、5xx、レート制限、通信断)は、noticeを残さず元の例外を投げる。
 * 一時的な障害でありうるので、呼び出し側のジョブの失敗にして、検知を弱めない。
 * noticeの記録が失敗しても、止める結果を隠さない。
 */
export async function verifyRepoOwnerId(
  config: Pick<FactoryConfig, "owners" | "factory_repo" | "factory_repo_id">,
  owner: string,
  repo: string,
  deps: RepoOwnerGateDeps,
): Promise<RepoOwnerGateResult> {
  const factoryRepo = isFactoryRepo(config.factory_repo, owner, repo);
  if (factoryRepo) {
    const factoryGate = await verifyFactoryRepo(config, owner, repo, deps);
    if (!factoryGate.ok) return factoryGate;
  }
  const configured = config.owners.find(
    (candidate) => candidate.name.toLowerCase() === owner.toLowerCase(),
  );
  if (configured === undefined) {
    if (factoryRepo) {
      return { ok: true };
    }
    await recordNotice(repoOwnerNotConfiguredMessage(`${owner}/${repo}`), deps);
    return {
      ok: false,
      reason: repoOwnerNotConfiguredReason(`${owner}/${repo}`),
    };
  }
  const expectedId = configured.id;
  if (expectedId === undefined) {
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

/**
 * `verifyRepoOwnerId`の結果を、止める理由か`null`(通る)に読み替える。
 * GitHubへ書き込む直前に呼ぶ終端のステップが、通らないときに書かず、その理由を終端に載せるためのもの。
 * noticeは`verifyRepoOwnerId`が残す。取得の失敗(404以外)は、元の例外のまま投げる。
 */
export async function repoOwnerStopReason(
  config: Pick<FactoryConfig, "owners" | "factory_repo" | "factory_repo_id">,
  owner: string,
  repo: string,
  deps: RepoOwnerGateDeps,
): Promise<string | null> {
  const result = await verifyRepoOwnerId(config, owner, repo, deps);
  return result.ok ? null : result.reason;
}

/**
 * `reason`が、この関門が返す止める理由のどれかを返す。
 * 理由の文字列だけを受け取る終端の処理が、Claudeの失敗として数えずに止めるかを決めるために使う。
 */
export function isRepoOwnerStopReason(reason: string): boolean {
  return (
    reason.startsWith(
      "repository owner id differs from factory_config owners: ",
    ) ||
    reason.startsWith(
      "repository not found while checking the owner id in factory_config owners: ",
    ) ||
    reason.startsWith("repository owner is not in factory_config owners: ") ||
    isFactoryRepoIdCheckReason(reason)
  );
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

/**
 * `factory_repo_id`があるときだけ、`factory_repo`のリポジトリIDを照合する。
 * `verifyFactoryRepoId`が残すnoticeを使い、その例外だけを止める結果に変える。
 * それ以外の例外(取得の失敗)は、そのまま投げる。
 */
async function verifyFactoryRepo(
  config: Pick<FactoryConfig, "factory_repo" | "factory_repo_id">,
  owner: string,
  repo: string,
  deps: RepoOwnerGateDeps,
): Promise<RepoOwnerGateResult> {
  try {
    await verifyFactoryRepoId(config, {
      getRepositoryId: deps.getRepositoryId,
      addNotice: deps.addNotice,
    });
  } catch (err) {
    if (err instanceof FactoryRepoIdMismatchError) {
      return {
        ok: false,
        reason: factoryRepoIdCheckReason(`${owner}/${repo}`),
      };
    }
    throw err;
  }
  return { ok: true };
}
