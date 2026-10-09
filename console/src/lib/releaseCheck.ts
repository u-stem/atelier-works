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

/** `signal`があるときだけinitに載せる(`exactOptionalPropertyTypes`のため)。 */
function requestInit(
  method: "GET" | "HEAD",
  signal?: AbortSignal,
): RequestInit {
  const init: RequestInit = { method, cache: "no-store" };
  if (signal !== undefined) {
    init.signal = signal;
  }
  return init;
}

/** 取得か解析に失敗したときはundefinedを返す。失敗は表示に反映しない。 */
async function fetchJson(
  fetchFn: FetchFn,
  url: string,
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    const response = await fetchFn(url, requestInit("GET", signal));
    if (!response.ok) {
      return undefined;
    }
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * 自分のファイルのうち、1つでも404のものがあるかを返す。
 * 1つ見つかれば「強く促す」には十分なので、そこで残りへのHEADをやめる。
 * 確かめられなかったものは404に数えない。中断されたときもやめる。
 */
async function anyMissing(
  fetchFn: FetchFn,
  assets: readonly string[],
  signal?: AbortSignal,
): Promise<boolean> {
  for (const asset of assets) {
    if (signal?.aborted) {
      return false;
    }
    try {
      const response = await fetchFn(
        `/console/${asset}`,
        requestInit("HEAD", signal),
      );
      if (response.status === 404) {
        return true;
      }
    } catch {
      // 確かめられなかったファイルは404に数えず、次のファイルへ進む。
    }
  }
  return false;
}

/**
 * 確認1回分の結果。
 * `reachable`は、配信中のmanifestを取って解析できたか。
 * 繰り返し失敗しているタブが、確認の間隔を延ばす判断に使う。
 */
export type ReleaseCheckResult = {
  notice: ReleaseNotice;
  reachable: boolean;
};

/**
 * 配信中の版のmanifestとstatusを取り、案内の強さを返す。
 * 自分のファイルのうちmanifestに無いものにだけHEADを順に送り、最初の404で止める。
 * manifestを取れなかったとき、前回がurgeのとき、自分のファイルが無いときは、前回の判定を返す。
 * `signal`が中断されると、実行中の取得は失敗として扱われ、前回の判定が残る。
 */
export async function checkRelease(
  fetchFn: FetchFn,
  ownAssets: ReadonlySet<string>,
  previous: ReleaseNotice,
  signal?: AbortSignal,
): Promise<ReleaseCheckResult> {
  if (previous === "urge" || ownAssets.size === 0) {
    return { notice: previous, reachable: true };
  }
  const [manifestBody, statusBody] = await Promise.all([
    fetchJson(fetchFn, MANIFEST_URL, signal),
    fetchJson(fetchFn, STATUS_URL, signal),
  ]);
  const manifestFiles = parseManifestFiles(manifestBody);
  const status = parseReleaseStatus(statusBody);
  const unserved =
    manifestFiles === null
      ? []
      : [...ownAssets].filter((name) => !manifestFiles.has(name));
  const ownAssetMissing = await anyMissing(fetchFn, unserved, signal);
  return {
    notice: judgeRelease({
      ownAssets,
      manifestFiles,
      status,
      ownAssetMissing,
      previous,
    }),
    reachable: manifestFiles !== null,
  };
}
