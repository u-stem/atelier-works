// スタブ。実装は次のコミットで書く。
export const ACCEPTED_PROFILES: readonly string[] = [];

export type RequiredApprovals = {
  readonly requirements: boolean;
  readonly design: boolean;
};

export function requiredApprovals(_profile: string): RequiredApprovals {
  return { requirements: false, design: false };
}
