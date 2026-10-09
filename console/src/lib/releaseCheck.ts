// 開いたままのタブの確認1回分(取得してから判定する)。
// fetchを引数に取るので、DOMなしでテストできる。

import {
  judgeRelease,
  parseManifestFiles,
  parseReleaseStatus,
  type ReleaseNotice,
} from "./release.ts";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const MANIFEST_URL = "/console/manifest.json";
const STATUS_URL = "/console/status.json";

/** 取得か解析に失敗したときはundefinedを返す。失敗は表示に反映しない。 */
async function fetchJson(fetchFn: FetchFn, url: string): Promise<unknown> {
  try {
    const response = await fetchFn(url, { cache: "no-store" });
    if (!response.ok) {
      return undefined;
    }
    return await response.json();
  } catch {
    return undefined;
  }
}

/** ファイルが404かを返す。確かめられなかったときはfalse。 */
async function isMissing(fetchFn: FetchFn, asset: string): Promise<boolean> {
  try {
    const response = await fetchFn(`/console/${asset}`, {
      method: "HEAD",
      cache: "no-store",
    });
    return response.status === 404;
  } catch {
    return false;
  }
}

/**
 * 配信中の版のmanifestとstatusを取り、案内の強さを返す。
 * 自分のファイルのうちmanifestに無いものにだけHEADを送り、404かを確かめる。
 * manifestを取れなかったとき、前回がurgeのとき、自分のファイルが無いときは、前回の判定を返す。
 */
export async function checkRelease(
  fetchFn: FetchFn,
  ownAssets: ReadonlySet<string>,
  previous: ReleaseNotice,
): Promise<ReleaseNotice> {
  if (previous === "urge" || ownAssets.size === 0) {
    return previous;
  }
  const [manifestBody, statusBody] = await Promise.all([
    fetchJson(fetchFn, MANIFEST_URL),
    fetchJson(fetchFn, STATUS_URL),
  ]);
  const manifestFiles = parseManifestFiles(manifestBody);
  const status = parseReleaseStatus(statusBody);
  const unserved =
    manifestFiles === null
      ? []
      : [...ownAssets].filter((name) => !manifestFiles.has(name));
  const missing = await Promise.all(
    unserved.map((name) => isMissing(fetchFn, name)),
  );
  return judgeRelease({
    ownAssets,
    manifestFiles,
    status,
    ownAssetMissing: missing.some(Boolean),
    previous,
  });
}
