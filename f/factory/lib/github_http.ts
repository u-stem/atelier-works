// GitHubのAPIへの通信層。実装の前の仮置きで、型だけを決め、値は誤ったものを返す。

import type { GitHubRateLimitError } from "./github_errors.ts";
import type { Logger } from "./log.ts";
import type { isRecord } from "./types.ts";

export const GITHUB_API_ORIGIN = "";

export type HttpResponseLike = {
  readonly status: number;
  readonly headers: {
    forEach(callback: (value: string, key: string) => void): void;
  };
  text(): Promise<string>;
};

export type HttpFetch = (
  url: string,
  init: RequestInit,
) => Promise<HttpResponseLike>;

export type GitHubHttpClient = {
  readonly token: string;
  readonly fetch?: HttpFetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  readonly log?: Logger;
  readonly transientRetryDelayMs?: number;
};

export type GitHubMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export type GitHubRequest = {
  readonly path: string;
  readonly method?: GitHubMethod;
  readonly body?: unknown;
  readonly accept?: string;
  readonly idempotent?: boolean;
  readonly timeoutMs?: number;
  readonly retry?: "once" | "never";
  readonly redirect?: "follow_same_origin" | "never";
};

export type RateLimitInfo = {
  readonly kind: "primary" | "secondary";
  readonly waitMs: number | null;
  readonly retryAfterSec: number | null;
  readonly resetAtSec: number | null;
  readonly resource: string | null;
};

export type GitHubHttpResponseCore = {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  readonly bodyText: string;
  readonly timedOut?: true;
  readonly incomplete?: true;
};

export type GitHubHttpResponse = GitHubHttpResponseCore & {
  readonly rateLimit: RateLimitInfo | null;
};

export type RateLimitPolicy =
  | { readonly mode: "wait_once"; readonly maxWaitMs?: number }
  | { readonly mode: "throw" }
  | { readonly mode: "report" };

export type GitHubSendResult<R> =
  | { readonly kind: "not_sent"; readonly error: unknown }
  | {
      readonly kind: "response";
      readonly response: R;
      readonly noResponse: boolean;
    };

export type RetryEnv = {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  readonly log?: Logger;
  readonly transientRetryDelayMs?: number;
};

export type RetryRequest = {
  readonly endpoint: string;
  readonly method?: GitHubMethod;
  readonly idempotent?: boolean;
  readonly retry?: "once" | "never";
};

export type _Unused = [typeof GitHubRateLimitError, typeof isRecord];

export function classifyRateLimit(
  _status: number,
  _headers: ReadonlyMap<string, string>,
  _bodyText: string,
  _now: Date,
): RateLimitInfo | null {
  return null;
}

export function graphqlErrorsRateLimited(_errors: readonly unknown[]): boolean {
  return false;
}

export function graphqlRateLimit(
  _headers: ReadonlyMap<string, string>,
  _now: Date,
): RateLimitInfo {
  return {
    kind: "secondary",
    waitMs: null,
    retryAfterSec: null,
    resetAtSec: null,
    resource: null,
  };
}

export function assertGitHubApiPath(_path: string): void {}

export async function runGitHubRequest<R extends GitHubHttpResponseCore>(
  _env: RetryEnv,
  _request: RetryRequest,
  _rateLimit: RateLimitPolicy,
  send: () => Promise<GitHubSendResult<R>>,
): Promise<R> {
  const result = await send();
  if (result.kind === "not_sent") throw new Error("not sent");
  return result.response;
}

export async function sendGitHubRequest(
  _client: GitHubHttpClient,
  _request: GitHubRequest,
): Promise<GitHubHttpResponse> {
  return { status: 0, headers: new Map(), bodyText: "", rateLimit: null };
}

export async function requestGitHub(
  _client: GitHubHttpClient,
  _request: GitHubRequest,
  _rateLimit: RateLimitPolicy = { mode: "wait_once" },
): Promise<GitHubHttpResponse> {
  return { status: 0, headers: new Map(), bodyText: "", rateLimit: null };
}
