export type NoticeMoveReason = "shown" | "arrived";

export type NoticeSeen = {
  readonly id: number | undefined;
  readonly visible: boolean;
};

export function noticeMoveReason(
  _prev: NoticeSeen,
  _next: NoticeSeen,
): NoticeMoveReason | null {
  return null;
}

export function shouldMoveToNotice(_input: {
  reason: NoticeMoveReason | null;
  active: unknown;
  body: unknown;
  trigger: unknown;
}): boolean {
  return false;
}
