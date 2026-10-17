/** 通知の理由(enum)と、固定の本文。自由な文字列は本文に入れない。 */

export const NOTIFY_REASONS: readonly string[] = [];

export type NotifyReason = string;

export function notificationText(_reason: NotifyReason, _sha: string): string {
  return "";
}

export type WebhookPayload = {
  readonly content: string;
  readonly allowed_mentions: { readonly parse: readonly string[] };
};

export function buildWebhookPayload(
  _reason: NotifyReason,
  _sha: string,
): WebhookPayload {
  return { content: "", allowed_mentions: { parse: ["everyone"] } };
}
