/** 人の承認が要る変更の判定。差のパスが、ホストで実行されるファイルに触れるかを見る。 */

export type ChangedFile = { readonly path: string; readonly status: string };

export function parseNameStatusZ(_output: string): ChangedFile[] {
  return [];
}

export function isApprovalTarget(_path: string): boolean {
  return false;
}

export function pickApprovalBase(_input: {
  readonly applied: string;
  readonly approved: string | null;
  readonly approvedFollowsApplied: boolean;
  readonly approvedPrecedesTarget: boolean;
}): string {
  return "";
}

export function approvalFiles(
  _changed: readonly ChangedFile[],
  _exemptPaths: ReadonlySet<string>,
): string[] {
  return ["stub"];
}
