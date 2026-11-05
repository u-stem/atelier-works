// 資格情報の期限の確認の仮の実装。テストが挙動の不一致で失敗するための誤った値だけを返す。

import type { NotifyEvent } from "./discord.ts";
import type { Logger } from "./log.ts";
import type { NoticeRecord } from "./types.ts";

export const CREDENTIAL_EXPIRY_VARIABLE_PATH = "f/factory/credential_expiry";
export const CREDENTIAL_EXPIRING_NOTICE_KIND = "credential_expiring";
export const CREDENTIAL_EXPIRING_RESOLVER = "notify_daily_summary";
export const WMILL_TOKEN_LIFETIME_DAYS = 0;
export const DEFAULT_CLAUDE_OAUTH_TOKEN_DAYS = 0;
export const CREDENTIAL_NEXT_ACTION = "";

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
  readonly problems: readonly string[];
  readonly unreadable: boolean;
};

export type CredentialDeadline = {
  readonly label: string;
  readonly expiresAt: Date;
};

export function parseCredentialExpiry(
  _raw: string | null,
): CredentialExpiryParse {
  return {
    record: { github_token: { expires_at: "" } },
    problems: [],
    unreadable: false,
  };
}

export function credentialDeadlines(
  _record: CredentialExpiryRecord,
): CredentialDeadline[] {
  return [];
}

export function jstDateLabel(_at: Date): string {
  return "";
}

export function credentialNoticeMessage(_deadline: CredentialDeadline): string {
  return "";
}

export function isExpiringSoon(
  _deadline: CredentialDeadline,
  _now: Date,
  _warnDays: number,
): boolean {
  return false;
}

export type CredentialExpiryDeps = {
  readonly now: () => Date;
  readonly warnDays: number;
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

export async function checkCredentialExpiry(
  _deps: CredentialExpiryDeps,
): Promise<CredentialExpiryResult | null> {
  return { expiring: 0, added: 0, resolved: 0 };
}
