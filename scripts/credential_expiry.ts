#!/usr/bin/env bun
// 資格情報の期限を集め、Windmillの変数`f/factory/credential_expiry`に入れるJSONを標準出力に書く。
// `scripts/bootstrap.sh`が手順7の続きで呼ぶ。
// GitHubのPATの期限は、`GET /user`の応答ヘッダー`github-authentication-token-expiration`から読む。
// interaction-limitsは、`GET /repos/{owner}/{repo}/interaction-limits`を試し、読めなければ`INTERACTION_LIMITS_EXPIRES_AT`を使う。
// トークンは環境変数で受け取り、引数にもログにも載せない。出力にもトークンを入れない(OAuthトークンは指紋だけ)。
// GitHubのトークンの期限を読めなかったとき(通信の失敗、200以外の応答)は、前回の記録の同じ項目を保ち、標準エラーに警告を出す。
//
// 入力の環境変数:
//   CREDENTIAL_EXPIRY_PREVIOUS         前回の記録(JSON)。無ければ空
//   CREDENTIAL_WMILL_TOKEN_ISSUED      この回にWindmillのトークンを発行したなら1
//   CREDENTIAL_READ_TOKENS             所有者からトークンへの対応表(JSON)。bootstrapの`read_token_map_json`が作る
//   GITHUB_TOKEN、CLAUDE_CODE_OAUTH_TOKEN、CLAUDE_OAUTH_TOKEN_DAYS、INTERACTION_LIMITS_REPO、INTERACTION_LIMITS_EXPIRES_AT

import {
  buildCredentialExpiryRecord,
  DEFAULT_CLAUDE_OAUTH_TOKEN_DAYS,
  parseCredentialExpiry,
  tokenExpirationFromHeader,
} from "../f/factory/lib/credential_expiry.ts";

export type GitHubFetch = (url: string, init: RequestInit) => Promise<Response>;

const GITHUB_API = "https://api.github.com";
const TIMEOUT_MS = 10_000;
const REPO_PATTERN = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 3650;

function githubHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "atelier-works-bootstrap",
  };
}

function githubInit(token: string): RequestInit {
  return {
    method: "GET",
    headers: githubHeaders(token),
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
}

/**
 * トークンの期限の読み取り結果。
 * `none`は期限の無いトークン、`unknown`は通信の失敗などで読めなかったことを表す。
 * 二つを分けるのは、読めなかっただけの資格情報を、記録から外して通知の解決に進ませないためである。
 */
export type TokenExpiry =
  | { readonly kind: "expires"; readonly at: string }
  | { readonly kind: "none" }
  | { readonly kind: "unknown" };

/** トークンの期限を読む。期限の無いトークンと、空のトークンは`none`を返す。 */
export async function tokenExpiresAt(
  token: string,
  fetchImpl: GitHubFetch,
): Promise<TokenExpiry> {
  if (token === "") return { kind: "none" };
  try {
    const response = await fetchImpl(`${GITHUB_API}/user`, githubInit(token));
    await response.body?.cancel().catch(() => {});
    if (response.status !== 200) return { kind: "unknown" };
    const header = response.headers.get(
      "github-authentication-token-expiration",
    );
    if (header === null) return { kind: "none" };
    const at = tokenExpirationFromHeader(header);
    return at === null ? { kind: "unknown" } : { kind: "expires", at };
  } catch {
    return { kind: "unknown" };
  }
}

/** interaction-limitsの期限を読む。読めない(権限が無い、設定が無い)ときは`null`を返す。 */
export async function interactionLimitsExpiresAt(
  repo: string,
  token: string,
  fetchImpl: GitHubFetch,
): Promise<string | null> {
  if (!REPO_PATTERN.test(repo) || token === "") return null;
  try {
    const response = await fetchImpl(
      `${GITHUB_API}/repos/${repo}/interaction-limits`,
      githubInit(token),
    );
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const body: unknown = await response.json();
    if (
      typeof body !== "object" ||
      body === null ||
      !("expires_at" in body) ||
      typeof body.expires_at !== "string"
    ) {
      return null;
    }
    const at = Date.parse(body.expires_at);
    return Number.isFinite(at) ? new Date(at).toISOString() : null;
  } catch {
    return null;
  }
}

/** `mise.local.toml`の日付(`YYYY-MM-DD`はJSTの0時)か、タイムゾーン付きの日時を読む。 */
export function configuredExpiresAt(value: string | undefined): string | null {
  const text = value?.trim() ?? "";
  if (text === "") return null;
  const at = Date.parse(DATE_ONLY.test(text) ? `${text}T00:00:00+09:00` : text);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/** 日数の設定を読む。1以上3650以下の整数でなければ`fallback`を返す。 */
export function parseDays(value: string | undefined, fallback: number): number {
  const text = value?.trim() ?? "";
  if (!/^[1-9]\d{0,3}$/.test(text)) return fallback;
  const days = Number(text);
  return days <= MAX_DAYS ? days : fallback;
}

/** 所有者からトークンへの対応表(JSON)を読む。読めなければ空にする。 */
export function readTokenMap(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const tokens: Record<string, string> = {};
  for (const [owner, token] of Object.entries(parsed)) {
    if (typeof token === "string" && token !== "") tokens[owner] = token;
  }
  return tokens;
}

/** トークンの値が変わったかを比べるための指紋。SHA-256の先頭16桁で、値は戻せない。 */
export function sha256Fingerprint(token: string): string {
  return new Bun.CryptoHasher("sha256")
    .update(token)
    .digest("hex")
    .slice(0, 16);
}

export type CollectEnv = Readonly<Record<string, string | undefined>>;

function warnOnStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * 環境変数とGitHubの応答から、変数に書くJSONを作る。
 * 期限を読めなかったGitHubのトークンは、前回の記録の同じ項目を保ち、`warn`で知らせる。
 * 前回の記録に無ければ項目を省く。
 */
export async function collectCredentialExpiry(
  env: CollectEnv,
  fetchImpl: GitHubFetch,
  now: Date,
  warn: (line: string) => void = warnOnStderr,
): Promise<string> {
  const previous = parseCredentialExpiry(
    env.CREDENTIAL_EXPIRY_PREVIOUS ?? null,
  ).record;
  const githubToken = env.GITHUB_TOKEN ?? "";
  // 同じトークンを複数の所有者が使っても、GitHubへ問い合わせるのは1度にする。
  const asked = new Map<string, TokenExpiry>();
  const expiryOf = async (token: string): Promise<TokenExpiry> => {
    const known = asked.get(token);
    if (known !== undefined) return known;
    const expiry = await tokenExpiresAt(token, fetchImpl);
    asked.set(token, expiry);
    return expiry;
  };
  // 読めなかったときは、前回の項目の期限を使う。無ければ`null`で、項目は省かれる。
  const resolve = (
    expiry: TokenExpiry,
    name: string,
    before: string | undefined,
  ): string | null => {
    if (expiry.kind === "expires") return expiry.at;
    if (expiry.kind === "none") return null;
    warn(
      `credential_expiry: could not read the expiry of ${name}; keeping the previous record`,
    );
    return before ?? null;
  };
  const readTokenExpiresAt: Record<string, string | null> = {};
  for (const [owner, token] of Object.entries(
    readTokenMap(env.CREDENTIAL_READ_TOKENS),
  )) {
    readTokenExpiresAt[owner] = resolve(
      await expiryOf(token),
      `github_read_tokens.${owner}`,
      previous.github_read_tokens?.[owner]?.expires_at,
    );
  }
  const claudeToken = env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
  const fromApi = await interactionLimitsExpiresAt(
    env.INTERACTION_LIMITS_REPO ?? "",
    githubToken,
    fetchImpl,
  );
  const record = buildCredentialExpiryRecord(
    {
      previous,
      wmillTokenIssued: env.CREDENTIAL_WMILL_TOKEN_ISSUED === "1",
      claudeFingerprint:
        claudeToken === "" ? null : sha256Fingerprint(claudeToken),
      claudeTokenDays: parseDays(
        env.CLAUDE_OAUTH_TOKEN_DAYS,
        DEFAULT_CLAUDE_OAUTH_TOKEN_DAYS,
      ),
      githubTokenExpiresAt: resolve(
        await expiryOf(githubToken),
        "github_token",
        previous.github_token?.expires_at,
      ),
      readTokenExpiresAt,
      interactionLimitsExpiresAt:
        fromApi ?? configuredExpiresAt(env.INTERACTION_LIMITS_EXPIRES_AT),
    },
    now,
  );
  return JSON.stringify(record);
}

if (import.meta.main) {
  process.stdout.write(
    await collectCredentialExpiry(process.env, fetch, new Date()),
  );
}
