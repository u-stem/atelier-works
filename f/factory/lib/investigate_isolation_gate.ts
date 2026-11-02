// 隔離の測定の結果を読み、調査のClaudeを起動してよいかを決める関門。
// 保護パスに置く。判定を緩めると、測定に合格していない隔離でClaudeを起動できるため。

import type { ListCompletedJobsData } from "windmill-client@1.817.0";
import type { IsolationProof } from "./isolation_proof.ts";

/** 関門が閉じた理由の符号。 */
export const ISOLATION_GATE_CODES = [
  "proof_missing",
  "proof_unreadable",
  "proof_failed",
  "version_changed",
  "isolation_changed",
] as const;

export type IsolationGateCode = (typeof ISOLATION_GATE_CODES)[number];

/** 関門が閉じた。符号を持つ。 */
export class IsolationGateError extends Error {
  readonly code: IsolationGateCode;

  constructor(code: IsolationGateCode) {
    super(`isolation gate closed: ${code}`);
    this.name = "IsolationGateError";
    this.code = code;
  }
}

/** 測定のジョブが無いときの通知の文。 */
export const PROOF_MISSING_NOTICE =
  "investigate_isolation_probeを実行してください。実行済みなら、実行した主体の権限を確かめてください。";

/** 測定のジョブを探すときに頼む件数。 */
export const PROBE_LOOKUP_PER_PAGE = 5;

export type IsolationGateDeps = {
  readonly workspace: string;
  readonly listCompletedJobs: (
    query: ListCompletedJobsData,
  ) => Promise<unknown>;
  readonly getCompletedJobResult: (id: string) => Promise<unknown>;
  readonly claudeVersion: string | undefined;
  readonly isolationFingerprint: string;
  readonly argvShapeHash: string;
  readonly probeJudgeVersion: number;
};

export type IsolationGateVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: IsolationGateCode };

export async function checkIsolationProofWithDeps(
  _deps: IsolationGateDeps,
): Promise<IsolationGateVerdict> {
  return { ok: false, code: "proof_missing" };
}

export async function checkIsolationProof(): Promise<IsolationProof> {
  const verdict = await checkIsolationProofWithDeps({
    workspace: "",
    listCompletedJobs: async () => [],
    getCompletedJobResult: async () => undefined,
    claudeVersion: undefined,
    isolationFingerprint: "",
    argvShapeHash: "",
    probeJudgeVersion: 0,
  });
  throw new IsolationGateError(verdict.ok ? "proof_missing" : verdict.code);
}
