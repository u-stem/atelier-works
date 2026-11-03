/** 送信の操作を受けたときに画面がすること。 */
export type SendDecision = "blocked" | "show-problems" | "send";

export function decideSend(_state: {
  readonly valid: boolean;
  readonly blocked: boolean;
}): SendDecision {
  return "send";
}
