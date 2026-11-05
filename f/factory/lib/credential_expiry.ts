// 資格情報の期限の記録を読み、期限が近いものを要対応の通知にする。
// 記録は、syncから外した秘密でない変数`f/factory/credential_expiry`(JSON)にあり、`mise run bootstrap`が書く。
// 日次のまとめ(`notify_daily_summary`)が毎日読み、期限の`credential_warn_days`日前を切った資格情報ごとに通知を残す。
// 本文に残り日数を入れない。本文の一致で重複を除くので、日ごとに本文が変わると、通知が毎日増えるためである。
// 期限が先に延びた資格情報と、記録から消えた資格情報の通知は、本文の一致で解決する。

import type { NotifyEvent } from "./discord.ts";
import { type Logger, maskSecrets } from "./log.ts";
import type { NoticeRecord } from "./types.ts";

export const CREDENTIAL_EXPIRY_VARIABLE_PATH = "f/factory/credential_expiry";
export const CREDENTIAL_EXPIRING_NOTICE_KIND = "credential_expiring";
/** 期限が先に延びた資格情報の通知を解決するときの、解決者の名前。 */
export const CREDENTIAL_EXPIRING_RESOLVER = "notify_daily_summary";
/** bootstrapが発行するWindmillのトークンの有効期間(日)。 */
export const WMILL_TOKEN_LIFETIME_DAYS = 180;
/** Claude CodeのOAuthトークンの有効期間の既定(日)。`CLAUDE_OAUTH_TOKEN_DAYS`で変える。 */
export const DEFAULT_CLAUDE_OAUTH_TOKEN_DAYS = 365;
/** 通知とDiscordの知らせに載せる、次の操作。 */
export const CREDENTIAL_NEXT_ACTION =
  "docs/operations.mdの「秘密をローテーションする」の手順で更新し、mise run bootstrapを実行する";

const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
/** GitHubのloginの形(小文字)。bootstrapが環境変数の名前から作る。 */
const OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;

export type ExpiryOnly = { readonly expires_at: string };
export type IssuedWindow = {
  readonly issued_at: string;
  readonly expires_at: string;
};
export type ClaudeWindow = IssuedWindow & { readonly fingerprint: string };

export type CredentialExpiryRecord = {
  readonly wmill_token?: IssuedWindow;
  readonly claude_oauth_token?: ClaudeWindow;
  readonly github_token?: ExpiryOnly;
  readonly github_read_tokens?: Readonly<Record<string, ExpiryOnly>>;
  readonly interaction_limits?: ExpiryOnly;
};

export type CredentialExpiryParse = {
  readonly record: CredentialExpiryRecord;
  /** 読めなかった項目。項目ごとに1件。 */
  readonly problems: readonly string[];
  /** 記録の全体が読めない。真のときは、既存の通知を解決しない。 */
  readonly unreadable: boolean;
};

export type CredentialDeadline = {
  readonly label: string;
  readonly expiresAt: Date;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function expiryOnly(value: unknown): ExpiryOnly | null {
  if (!isRecord(value) || !isTime(value.expires_at)) return null;
  return { expires_at: value.expires_at };
}

function issuedWindow(value: unknown): IssuedWindow | null {
  if (!isRecord(value) || !isTime(value.issued_at)) return null;
  const expiry = expiryOnly(value);
  return expiry === null
    ? null
    : { issued_at: value.issued_at, expires_at: expiry.expires_at };
}

function claudeWindow(value: unknown): ClaudeWindow | null {
  const window = issuedWindow(value);
  if (window === null || !isRecord(value)) return null;
  return typeof value.fingerprint === "string" && value.fingerprint !== ""
    ? { ...window, fingerprint: value.fingerprint }
    : null;
}

/** 項目を読み、無ければ`undefined`、壊れていれば問題を足して`undefined`を返す。 */
function entry<T>(
  raw: Record<string, unknown>,
  key: string,
  read: (value: unknown) => T | null,
  problems: string[],
): T | undefined {
  if (raw[key] === undefined) return undefined;
  const value = read(raw[key]);
  if (value === null) {
    problems.push(`${key} is malformed`);
    return undefined;
  }
  return value;
}

function readTokens(
  value: unknown,
  problems: string[],
): Record<string, ExpiryOnly> | null {
  if (!isRecord(value)) return null;
  const tokens: Record<string, ExpiryOnly> = {};
  for (const [owner, raw] of Object.entries(value)) {
    const expiry = expiryOnly(raw);
    if (!OWNER_PATTERN.test(owner) || expiry === null) {
      problems.push("github_read_tokens has a malformed owner");
      continue;
    }
    tokens[owner] = expiry;
  }
  return tokens;
}

/** 変数の値を解析する。壊れた項目は落とし、`problems`に残す。 */
export function parseCredentialExpiry(
  raw: string | null,
): CredentialExpiryParse {
  if (raw === null || raw.trim() === "") {
    return { record: {}, problems: [], unreadable: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      record: {},
      problems: ["the record is not JSON"],
      unreadable: true,
    };
  }
  if (!isRecord(parsed)) {
    return {
      record: {},
      problems: ["the record is not an object"],
      unreadable: true,
    };
  }
  const problems: string[] = [];
  const wmillToken = entry(parsed, "wmill_token", issuedWindow, problems);
  const claude = entry(parsed, "claude_oauth_token", claudeWindow, problems);
  const github = entry(parsed, "github_token", expiryOnly, problems);
  const reads = entry(
    parsed,
    "github_read_tokens",
    (value) => readTokens(value, problems),
    problems,
  );
  const limits = entry(parsed, "interaction_limits", expiryOnly, problems);
  return {
    record: {
      ...(wmillToken === undefined ? {} : { wmill_token: wmillToken }),
      ...(claude === undefined ? {} : { claude_oauth_token: claude }),
      ...(github === undefined ? {} : { github_token: github }),
      ...(reads === undefined ? {} : { github_read_tokens: reads }),
      ...(limits === undefined ? {} : { interaction_limits: limits }),
    },
    problems,
    unreadable: false,
  };
}

/** 記録にある資格情報と期限を、決まった順に並べる。 */
export function credentialDeadlines(
  record: CredentialExpiryRecord,
): CredentialDeadline[] {
  const deadlines: CredentialDeadline[] = [];
  const push = (label: string, expiry: ExpiryOnly | undefined): void => {
    if (expiry !== undefined) {
      deadlines.push({ label, expiresAt: new Date(expiry.expires_at) });
    }
  };
  push("Windmillのトークン(wmill_token)", record.wmill_token);
  push(
    "Claude CodeのOAuthトークン(claude_oauth_token)",
    record.claude_oauth_token,
  );
  push("GitHubのPAT(github_token)", record.github_token);
  for (const [owner, expiry] of Object.entries(
    record.github_read_tokens ?? {},
  )) {
    push(`読み取り専用のGitHubのPAT(github_read_tokens、${owner})`, expiry);
  }
  push("GitHubのinteraction-limits", record.interaction_limits);
  return deadlines;
}

/** `at`が属するJSTの日付を`YYYY-MM-DD`で返す。 */
export function jstDateLabel(at: Date): string {
  const shifted = new Date(at.getTime() + JST_OFFSET_MS);
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${String(shifted.getUTCFullYear())}-${month}-${day}`;
}

/** 通知の本文。残り日数を含めない。 */
export function credentialNoticeMessage(deadline: CredentialDeadline): string {
  return `${deadline.label}の期限が${jstDateLabel(deadline.expiresAt)}に切れる。次の操作: ${CREDENTIAL_NEXT_ACTION}`;
}

/** 期限まで`warnDays`日以内か、期限を過ぎているか。 */
export function isExpiringSoon(
  deadline: CredentialDeadline,
  now: Date,
  warnDays: number,
): boolean {
  return deadline.expiresAt.getTime() - now.getTime() <= warnDays * DAY_MS;
}

export type CredentialExpiryDeps = {
  readonly now: () => Date;
  readonly warnDays: number;
  /** 変数の値。変数が無いと確かめられたときだけ`null`を返す。 */
  readonly readRecord: () => Promise<string | null>;
  readonly listUnresolved: () => Promise<
    readonly { readonly message: string }[]
  >;
  readonly addNotice: (record: NoticeRecord) => Promise<number | null>;
  readonly resolveByMessage: (message: string) => Promise<number>;
  readonly notify: (event: NotifyEvent) => Promise<unknown>;
  readonly instanceName: string;
  readonly log: Logger;
};

export type CredentialExpiryResult = {
  readonly expiring: number;
  readonly added: number;
  readonly resolved: number;
};

async function runCheck(
  deps: CredentialExpiryDeps,
): Promise<CredentialExpiryResult> {
  const parsed = parseCredentialExpiry(await deps.readRecord());
  for (const problem of parsed.problems) {
    deps.log.warn("the credential expiry record has a problem", { problem });
  }
  if (parsed.unreadable) return { expiring: 0, added: 0, resolved: 0 };
  const now = deps.now();
  const expiring = credentialDeadlines(parsed.record).filter((deadline) =>
    isExpiringSoon(deadline, now, deps.warnDays),
  );
  const wanted = new Set(expiring.map(credentialNoticeMessage));
  let resolved = 0;
  for (const notice of await deps.listUnresolved()) {
    if (!wanted.has(notice.message)) {
      resolved += await deps.resolveByMessage(notice.message);
    }
  }
  let added = 0;
  for (const deadline of expiring) {
    const message = credentialNoticeMessage(deadline);
    const id = await deps.addNotice({
      kind: CREDENTIAL_EXPIRING_NOTICE_KIND,
      message,
    });
    if (id === null) continue;
    added += 1;
    await deps.notify({
      kind: "credential_expiring",
      instance_name: deps.instanceName,
      cause: message,
      next_action: CREDENTIAL_NEXT_ACTION,
    });
  }
  return { expiring: expiring.length, added, resolved };
}

/**
 * 期限が近い資格情報ごとに通知を残し、新しく残したものはDiscordにも知らせる。
 * 失敗しても例外を投げず、警告のログを残して`null`を返す。日次のまとめを止めないためである。
 */
export async function checkCredentialExpiry(
  deps: CredentialExpiryDeps,
): Promise<CredentialExpiryResult | null> {
  try {
    return await runCheck(deps);
  } catch (err) {
    deps.log.warn("could not check the credential expiry", {
      error: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// 記録の組み立て(ホストの`scripts/credential_expiry.ts`が使う)
// ---------------------------------------------------------------------------

export type CredentialRecordInput = {
  readonly previous: CredentialExpiryRecord;
  readonly wmillTokenIssued: boolean;
  readonly claudeFingerprint: string | null;
  readonly claudeTokenDays: number;
  readonly githubTokenExpiresAt: string | null;
  readonly readTokenExpiresAt: Readonly<Record<string, string | null>>;
  readonly interactionLimitsExpiresAt: string | null;
};

export function tokenExpirationFromHeader(
  _value: string | undefined,
): string | null {
  return null;
}

export function buildCredentialExpiryRecord(
  _input: CredentialRecordInput,
  _now: Date,
): CredentialExpiryRecord {
  return {};
}
