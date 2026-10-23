// flowを起動する辺の表。文書のフローの表と、契約テストの正本になる。

/** 辺の種類。scriptがコードで起動するか、人がコードを介さずに起動するか。 */
export type LaunchKind = "script" | "human";

export type LaunchEdge = {
  readonly from: string;
  readonly to: string;
  readonly kind: LaunchKind;
};

export const LAUNCH_EDGES: readonly LaunchEdge[] = [];

export const HUMAN_OPERATIONS: Readonly<Record<string, string>> = {};

export const HUMAN_ENTRY_SCRIPTS: Readonly<Record<string, string>> = {};

export function describeOrigin(_edge: LaunchEdge): string {
  return "";
}
