// CIが出したメタデータのパッチ(artifactのzip)を、バイト列で取得する。
// 取得は通信層(`github_http.ts`)の`downloadRedirectTarget`に任せる。
// トークンはAPIへの最初の要求にだけ載り、取得先はAzureのblob storageの`https`に限られる。
// 取得したバイト列は信用せず、呼び出し側が検査する。
// `github.ts`は子プロセスにつながるのでimportしない。

import { downloadRedirectTarget } from "./github_http.ts";
import { assertGitHubName } from "./types.ts";

/** endpointを組み立てる前に、`owner/repo`の両方を検証する。 */
function validateOwnerRepo(owner: string, repo: string): void {
  assertGitHubName(owner);
  assertGitHubName(repo);
}

/** 正の安全な整数か。endpointに入れるIDは、この条件を満たすものだけにする。 */
function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * artifactのダウンロードの呼び出し側。
 * `gh`の出力は文字列に復号されてzipの中身が壊れるため、ダウンロードは通信層の`fetch`で行う。
 * トークンは、GitHubのAPIへの最初の要求の`Authorization`ヘッダーにだけ載る。
 */
export type ArtifactDownloadClient = {
  readonly ghToken: string;
  /** APIへの要求と取得先への要求を合わせて許す時間(ミリ秒)。既定は`ARTIFACT_FETCH_TIMEOUT_MS`。 */
  readonly timeoutMs?: number;
  readonly now?: () => Date;
};

export const ARTIFACT_FETCH_TIMEOUT_MS = 60_000;

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

/**
 * artifactのzipをバイト列で取得する。取得したzipは信用せず、呼び出し側が検査する。
 * 取得の前に、期限切れと、申告された大きさ(`sizeInBytes`)が`maxBytes`を超えるものを断る。
 * 手順は2つで、まずAPIに、トークンつきでリダイレクトをたどらずに要求する。
 * 返った302の`Location`が、`https`のAzureのblob storageでなければ断る。
 * 次に、そのURLへトークンなしで要求し、リダイレクトはたどらない。
 * 本文は、実際に受け取ったバイト数が`maxBytes`を超えた時点で読むのをやめて断る。
 * 2つの手順は通信層の`downloadRedirectTarget`が行い、締め切りを共有する。
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
  const result = await downloadRedirectTarget(
    {
      token: client.ghToken,
      ...(client.now !== undefined ? { now: client.now } : {}),
    },
    {
      path: `repos/${owner}/${repo}/actions/artifacts/${String(artifact.id)}/zip`,
    },
    "artifact",
    {
      as: "bytes",
      maxBytes,
      timeoutMs: client.timeoutMs ?? ARTIFACT_FETCH_TIMEOUT_MS,
    },
  );
  switch (result.kind) {
    case "bytes":
      return result.bytes;
    case "api_response": {
      const status = result.response.status;
      if (status === 0) throw new GitHubArtifactDownloadError("network");
      throw new GitHubArtifactDownloadError(
        status >= 200 && status < 300 ? "bad_redirect" : "api_status",
        status,
      );
    }
    case "bad_redirect":
      throw new GitHubArtifactDownloadError("bad_redirect");
    case "storage_status":
      throw new GitHubArtifactDownloadError("storage_status", result.status);
    case "too_large":
      throw new GitHubArtifactDownloadError("too_large");
    case "no_response":
    case "incomplete":
    case "text":
      throw new GitHubArtifactDownloadError("network");
  }
}
