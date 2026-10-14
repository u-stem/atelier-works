// CIが出したメタデータのパッチ(artifactのzip)を、バイト列で取得する。
// `gh api`の出力は文字列に復号されてzipが壊れるため、`fetch`で取得する。
// トークンはAPIへの最初の要求にだけ載せ、取得先はAzureのblob storageの`https`に限る。
// 取得したバイト列は信用せず、呼び出し側が検査する。

import {
  GitHubRateLimitError,
  isRateLimited,
  rateLimitWaitMs,
  validateOwnerRepo,
} from "./github.ts";

/** 正の安全な整数か。endpointに入れるIDは、この条件を満たすものだけにする。 */
function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** artifactのダウンロードに使う`fetch`。テストでは差し替える。 */
export type ArtifactFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

/**
 * artifactのダウンロードの呼び出し側。
 * `gh`の出力は文字列に復号されてzipの中身が壊れるため、ダウンロードは`fetch`で行う。
 * トークンは、GitHubのAPIへの最初の要求の`Authorization`ヘッダーにだけ載せる。
 */
export type ArtifactDownloadClient = {
  readonly ghToken: string;
  readonly fetch: ArtifactFetch;
  /** 1回の要求と本文の読み取りに許す時間(ミリ秒)。既定は`ARTIFACT_FETCH_TIMEOUT_MS`。 */
  readonly timeoutMs?: number;
  readonly now?: () => Date;
};

export const ARTIFACT_FETCH_TIMEOUT_MS = 60_000;

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const ARTIFACT_USER_AGENT = "atelier-works-factory";
/** artifactの取得先として認めるホストの末尾。GitHubはAzureのblob storageの署名付きURLへ302で渡す。 */
const ARTIFACT_STORAGE_HOST_SUFFIX = ".blob.core.windows.net";

export type ArtifactDownloadFailure =
  | "expired"
  | "too_large"
  | "bad_redirect"
  | "api_status"
  | "storage_status"
  | "network";

/**
 * artifactのダウンロードの失敗。
 * 署名付きURL、応答の本文、トークンを載せない。載せるのは失敗の種別とHTTPのステータスだけである。
 * `status`が0のときは、HTTPの応答を得る前の失敗である。
 */
export class GitHubArtifactDownloadError extends Error {
  readonly kind: ArtifactDownloadFailure;
  readonly status: number;
  constructor(kind: ArtifactDownloadFailure, status = 0) {
    super(
      `GET artifact zip failed: ${kind}${status > 0 ? ` (HTTP ${String(status)})` : ""}`,
    );
    this.name = "GitHubArtifactDownloadError";
    this.kind = kind;
    this.status = status;
  }
}

function assertArtifactId(artifactId: number): void {
  if (!isPositiveSafeInteger(artifactId)) {
    throw new Error(`invalid artifact id: ${String(artifactId)}`);
  }
}

/** 取得先として認めるURLか。`https`のAzureのblob storageで、認証情報とポートを含まないものだけを認める。 */
function isAllowedArtifactStorageUrl(location: string): boolean {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    url.hostname.endsWith(ARTIFACT_STORAGE_HOST_SUFFIX)
  );
}

async function sendArtifactRequest(
  client: ArtifactDownloadClient,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await client.fetch(url, {
      ...init,
      signal: AbortSignal.timeout(
        client.timeoutMs ?? ARTIFACT_FETCH_TIMEOUT_MS,
      ),
    });
  } catch {
    // 通信のエラーの文面にはURLが入りうるので、載せない。
    throw new GitHubArtifactDownloadError("network");
  }
}

/** 本文の次の断片を読む。途中で切れた接続や時間切れは`network`の失敗にする。 */
async function readArtifactChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
) {
  try {
    return await reader.read();
  } catch {
    throw new GitHubArtifactDownloadError("network");
  }
}

/** 本文を、実際に受け取ったバイト数で`maxBytes`を確かめながら読む。超えたら読むのをやめて失敗にする。 */
async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new GitHubArtifactDownloadError("too_large");
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await readArtifactChunk(reader);
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new GitHubArtifactDownloadError("too_large");
    }
    chunks.push(chunk.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * artifactのzipをバイト列で取得する。取得したzipは信用せず、呼び出し側が検査する。
 * 取得の前に、期限切れと、申告された大きさ(`sizeInBytes`)が`maxBytes`を超えるものを断る。
 * 手順は2つで、まずAPIに、トークンつきでリダイレクトをたどらずに要求する。
 * 返った302の`Location`が、`https`のAzureのblob storageでなければ断る。
 * 次に、そのURLへトークンなしで要求し、リダイレクトはたどらない。
 * 本文は、実際に受け取ったバイト数が`maxBytes`を超えた時点で読むのをやめて断る。
 * ログとDBに載せない前提のバイト列を返すだけで、本文を文字列にしない。
 * 失敗は`GitHubArtifactDownloadError`で、rate limitは`GitHubRateLimitError`で伝える。
 */
export async function downloadArtifactZip(
  client: ArtifactDownloadClient,
  owner: string,
  repo: string,
  artifact: {
    readonly id: number;
    readonly sizeInBytes: number;
    readonly expired: boolean;
  },
  maxBytes: number,
): Promise<Uint8Array> {
  validateOwnerRepo(owner, repo);
  assertArtifactId(artifact.id);
  if (artifact.expired) throw new GitHubArtifactDownloadError("expired");
  if (artifact.sizeInBytes > maxBytes) {
    throw new GitHubArtifactDownloadError("too_large");
  }
  const endpoint = `repos/${owner}/${repo}/actions/artifacts/${String(artifact.id)}/zip`;
  const first = await sendArtifactRequest(
    client,
    `${GITHUB_API_ORIGIN}/${endpoint}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${client.ghToken}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": ARTIFACT_USER_AGENT,
      },
      redirect: "manual",
    },
  );
  await first.body?.cancel().catch(() => undefined);
  if (first.status < 300 || first.status >= 400) {
    const headers = new Map(first.headers);
    if (isRateLimited({ status: first.status, headers, bodyText: "" })) {
      throw new GitHubRateLimitError(
        endpoint,
        rateLimitWaitMs(headers, client.now ?? (() => new Date())),
        false,
      );
    }
    throw new GitHubArtifactDownloadError(
      first.status >= 200 && first.status < 300 ? "bad_redirect" : "api_status",
      first.status,
    );
  }
  const location = first.headers.get("location");
  if (location === null || !isAllowedArtifactStorageUrl(location)) {
    throw new GitHubArtifactDownloadError("bad_redirect");
  }
  const second = await sendArtifactRequest(client, location, {
    headers: { "User-Agent": ARTIFACT_USER_AGENT },
    redirect: "error",
  });
  if (!second.ok) {
    await second.body?.cancel().catch(() => undefined);
    throw new GitHubArtifactDownloadError("storage_status", second.status);
  }
  return readBodyWithLimit(second, maxBytes);
}
