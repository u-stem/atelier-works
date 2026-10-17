/** 通知の理由(enum)と、固定の本文。自由な文字列は本文に入れない。 */

/**
 * 通知の理由。本文はこの一覧のどれかに対応する固定の文だけにする。
 * `doctor`や`bootstrap`の出力、エラーメッセージは、秘密値や任意の文字列を含みうるので載せない。
 */
export const NOTIFY_REASONS = [
  "rejected_compose_forbidden",
  "rejected_mise_forbidden",
  "rejected_unknown_service",
  "rejected_caddy_invalid",
  "rejected_not_ff",
  "rejected_ci_failed",
  "rejected_docker_version",
  "pending_approval",
  "failed_repeated",
  "pending_over_limit",
  "stale_24h",
  "drift",
  "doctor_ng",
  "state_unreadable",
  "restore_impossible",
  "mise_local_missing",
  "recovered",
] as const;

export type NotifyReason = (typeof NOTIFY_REASONS)[number];

function isNotifyReason(value: string): value is NotifyReason {
  return NOTIFY_REASONS.some((reason) => reason === value);
}

/** 理由ごとの文。`{sha}`の位置に、7桁のshaが入る。 */
const TEMPLATES: Readonly<Record<NotifyReason, string>> = {
  rejected_compose_forbidden:
    "反映を見送りました。composeの定義に、許可していない形が含まれています(コミット {sha})。",
  rejected_mise_forbidden:
    "反映を見送りました。mise.tomlの値が、読み取れない形か、許可していない形です(コミット {sha})。",
  rejected_unknown_service:
    "反映を見送りました。許可していないサービス名がcomposeにあります。実行役の更新(mise run host:install)が必要な可能性があります(コミット {sha})。",
  rejected_caddy_invalid:
    "反映を見送りました。Caddyfileの検証に失敗しました(コミット {sha})。",
  rejected_not_ff:
    "反映を見送りました。適用済みのコミットの子孫ではありません(コミット {sha})。",
  rejected_ci_failed:
    "反映を見送りました。必須のCIチェックが失敗しています(コミット {sha})。",
  rejected_docker_version:
    "反映を見送りました。dockerの版が要件を満たしていません(コミット {sha})。",
  pending_approval:
    "人の承認を待っています(コミット {sha})。内容を確かめ、mise run host:approve {sha} を実行してください。",
  failed_repeated:
    "反映が連続して失敗しています(コミット {sha})。ホストのログを確認してください。",
  pending_over_limit:
    "排水の待ちが上限を超えています(コミット {sha})。実行中のジョブを確認し、必要なら人が判断してください。",
  stale_24h: "必須のCIチェックの通過を24時間待っています(コミット {sha})。",
  drift:
    "本番の構成が、適用済みの定義とずれています(適用済みのコミット {sha})。",
  doctor_ng:
    "反映の後の診断で問題が見つかりました(コミット {sha})。mise run doctor で確認してください。",
  state_unreadable:
    "実行役の状態ファイルが読めないため、止まっています(適用済みのコミット {sha})。",
  restore_impossible:
    "止めたサービスを元に戻せないため、止まっています(コミット {sha})。人が確認してください。",
  mise_local_missing:
    "mise.local.tomlのリンク先が見つからないため、止まっています(コミット {sha})。",
  recovered: "反映が復旧しました(コミット {sha})。",
};

/**
 * 理由に対応する固定の文を返す。shaは7桁に切って入れる。
 * 16進でないshaと、一覧に無い理由は例外にする。呼び出し側の文字列が本文に入らないようにするため。
 */
export function notificationText(reason: string, sha: string): string {
  if (!isNotifyReason(reason)) throw new Error("unknown notification reason");
  if (!/^[0-9a-f]{7,40}$/.test(sha)) {
    throw new Error("sha must be 7 to 40 lowercase hex digits");
  }
  return TEMPLATES[reason].replaceAll("{sha}", sha.slice(0, 7));
}

export type WebhookPayload = {
  readonly content: string;
  readonly allowed_mentions: { readonly parse: readonly string[] };
};

/** Discordのwebhookに送る本文。`allowed_mentions`を空にして、本文からのメンションを無効にする。 */
export function buildWebhookPayload(
  reason: string,
  sha: string,
): WebhookPayload {
  return {
    content: notificationText(reason, sha),
    allowed_mentions: { parse: [] },
  };
}
