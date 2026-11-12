// 通知の種類から、運用の文書の「通知の種類」の表の行へのリンクを決める。
// 種類ごとのデータは持たず、表の各行に置いたアンカー`notice-<種類>`を規則で指す。
// リポジトリは、設定の`factory_repo`(Factory自身のリポジトリ)から実行時に読む。

import type { ConfigSnapshotView } from "../api/jobsQueries.ts";
import { GENERIC_NOTICE_GUIDE, noticeGuide } from "./noticeGuide.ts";

/**
 * 通知の種類の形。backendの種類はすべてこの形で、`docs/operations.md`の表の検査も同じ形で読む。
 * 正規表現の断片なので、`^`と`$`で囲んで使う。
 */
export const NOTICE_KIND_SOURCE = "[a-z][a-z0-9_]*";

/** アンカーの名前にそのまま入れてよい種類。種類はDBから来る値なので、外れる値は変換せずリンクにしない。 */
const ANCHOR_KIND_PATTERN = new RegExp(`^${NOTICE_KIND_SOURCE}$`);

/** 表に行の無い種類が指す、通知の種類の節の見出しのアンカー。 */
const NOTICE_KINDS_SECTION_ANCHOR = "通知の種類";

/**
 * `factory_repo`の形。backendの`parseGitHubRepoUrl`(`f/factory/lib/types.ts`)と同じく、
 * ホスト名の大文字小文字を問わず、末尾の`.git`とスラッシュを省ける。
 */
const FACTORY_REPO_URL_PATTERN =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/*$/i;

/** GitHubのログイン名とリポジトリ名の形。backendの`assertGitHubName`と同じ規則である。 */
const GITHUB_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isGitHubName(name: string): boolean {
  return name !== "." && name !== ".." && GITHUB_NAME_PATTERN.test(name);
}

/** GitHubのリポジトリの持ち主と名前。 */
export type GitHubRepository = {
  readonly owner: string;
  readonly repo: string;
};

/**
 * 設定の取得の結果の`factory_repo`から、Factory自身のリポジトリを読む。
 * 取得の前、未設定、参照で書かれた値、GitHubのリポジトリのURLの形でない値は`null`を返す。
 * 持ち主と名前は、URLに入れる前にGitHubの名前の形を確かめる。
 */
export function factoryRepository(
  snapshot: ConfigSnapshotView | undefined,
): GitHubRepository | null {
  const item = snapshot?.items.find((each) => each.key === "factory_repo");
  if (item?.kind !== "value" || typeof item.value !== "string") {
    return null;
  }
  const match = FACTORY_REPO_URL_PATTERN.exec(item.value.trim());
  const owner = match?.[1];
  const repo = match?.[2];
  if (owner === undefined || repo === undefined) {
    return null;
  }
  return isGitHubName(owner) && isGitHubName(repo) ? { owner, repo } : null;
}

/** 通知の表の行のアンカーの名前。`kind`がアンカーに入れられない形なら`null`を返す。 */
export function noticeDocAnchor(kind: string): string | null {
  return ANCHOR_KIND_PATTERN.test(kind) ? `notice-${kind}` : null;
}

/**
 * 運用の文書の、通知の種類の手順を指すURL。リポジトリが読めないときは`null`を返す。
 * Consoleが説明を持つ種類(`noticeGuide.ts`の一覧で、backendの種類と一致する)は表のその行を、
 * それ以外の種類は表の節の見出しを指す。
 * 指すのはmainの文書である。Consoleは別に反映され、前の版へ戻すこともあるので、
 * mainの文書の手順と、動いている版の挙動がずれることがある。
 */
export function noticeDocUrl(
  kind: string,
  repository: GitHubRepository | null,
): string | null {
  if (repository === null) {
    return null;
  }
  const anchor =
    noticeGuide(kind) === GENERIC_NOTICE_GUIDE ? null : noticeDocAnchor(kind);
  return `https://github.com/${repository.owner}/${repository.repo}/blob/main/docs/operations.md#${anchor ?? NOTICE_KINDS_SECTION_ANCHOR}`;
}
