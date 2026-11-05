// 外部の死活監視サービス(Healthchecks.io、Uptime Kumaのpush、Cronitorなど)のURLを叩く。
// 叩かれなくなったことを外のサービスが知らせるので、ホストやDockerごと止まったことにも気づける。
// URLは秘密の変数`f/factory/heartbeat_url`にあり、結果とログに載せない。
// 失敗は結果で返し、例外を投げない。叩けなくても、呼び出し側の処理の結果を変えないためである。

import { maskSecrets } from "./log.ts";

/** 1回の呼び出しの上限(ミリ秒)。 */
export const HEARTBEAT_TIMEOUT_MS = 10_000;

export type HeartbeatFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export type HeartbeatResult =
  | { readonly kind: "disabled" }
  | { readonly kind: "sent" }
  | { readonly kind: "rejected"; readonly reason: "invalid_url" | "not_https" }
  | { readonly kind: "failed"; readonly reason: string };

function isTimeout(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  );
}

/** 失敗の理由。URLを伏せる。 */
function failureReason(err: unknown, url: string): string {
  if (isTimeout(err)) return "timed out";
  return maskSecrets(err instanceof Error ? err.message : String(err), [url]);
}

/**
 * `url`を`GET`で叩く。空なら何もしない。`https:`以外は叩かない。
 * リダイレクトは追わない。宛先を変えさせないためである。2xxだけを成功とする。
 */
export async function pingHeartbeat(
  url: string,
  fetchImpl: HeartbeatFetch,
  timeoutMs: number = HEARTBEAT_TIMEOUT_MS,
): Promise<HeartbeatResult> {
  const trimmed = url.trim();
  if (trimmed === "") return { kind: "disabled" };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { kind: "rejected", reason: "invalid_url" };
  }
  if (parsed.protocol !== "https:") {
    return { kind: "rejected", reason: "not_https" };
  }
  let response: Response;
  try {
    response = await fetchImpl(parsed.href, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { kind: "failed", reason: failureReason(err, trimmed) };
  }
  await response.body?.cancel().catch(() => {});
  if (response.status >= 200 && response.status < 300) return { kind: "sent" };
  return { kind: "failed", reason: `HTTP ${String(response.status)}` };
}
