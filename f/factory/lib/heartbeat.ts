// 外部の死活監視サービスのURLを叩く部品。

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

export async function pingHeartbeat(
  _url: string,
  _fetchImpl: HeartbeatFetch,
  _timeoutMs: number = HEARTBEAT_TIMEOUT_MS,
): Promise<HeartbeatResult> {
  return { kind: "disabled" };
}
