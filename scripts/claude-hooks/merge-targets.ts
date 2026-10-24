// 暫定の実装。常に何も見つけない。

export type GuardedOperation =
  | { readonly kind: "merge"; readonly repo: string | null }
  | { readonly kind: "deploy"; readonly via: "sync_push" | "migrate" };

export function findGuardedOperations(
  _command: string,
): readonly GuardedOperation[] {
  return [];
}
