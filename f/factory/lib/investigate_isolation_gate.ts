// 隔離の測定の結果を読み、調査のClaudeを起動してよいかを決める関門。
// 保護パスに置く。判定を緩めると、測定に合格していない隔離でClaudeを起動できるため。
//
// 測定(`investigate_isolation_probe`)の最新の完了ジョブの結果が、今の隔離と一致するときだけ証拠を作る。
// 測定のジョブが無い間は、`proof_missing`で閉じる。
// 前提: 測定を実行する主体と、関門を呼ぶ主体が、同じ範囲のジョブ記録を読める。

import type { ListCompletedJobsData } from "windmill-client@1.817.0";
import wmillDefault, * as wmill from "windmill-client@1.817.0";
import {
  computeArgvShapeHash,
  ISOLATION_FINGERPRINT,
  PROBE_JOB_TAG,
  PROBE_JUDGE_VERSION,
  PROBE_SCRIPT_PATH,
} from "./investigate_isolation.ts";
import { type IsolationProof, mintIsolationProof } from "./isolation_proof.ts";
import { isRecord, isString } from "./types.ts";

/** 関門が閉じた理由の符号。 */
export const ISOLATION_GATE_CODES = [
  "proof_missing",
  "proof_unreadable",
  "proof_failed",
  "version_changed",
  "isolation_changed",
] as const;

export type IsolationGateCode = (typeof ISOLATION_GATE_CODES)[number];

/** 関門が閉じた。符号だけを持ち、読んだ結果の本文は持たない。 */
export class IsolationGateError extends Error {
  readonly code: IsolationGateCode;

  constructor(code: IsolationGateCode) {
    super(`isolation gate closed: ${code}`);
    this.name = "IsolationGateError";
    this.code = code;
  }
}

/** 測定のジョブが見つからないときに、通知へ載せる文。 */
export const PROOF_MISSING_NOTICE =
  "investigate_isolation_probeを実行してください。実行済みなら、実行した主体の権限を確かめてください。";

/**
 * 測定のジョブを探すときに頼む件数。
 * 一覧の並びはサーバーに任せず、判定側で開始時刻の降順に選ぶ。サーバーの絞りを通っても採れないジョブが混ざりうるので、数件は取る。
 */
export const PROBE_LOOKUP_PER_PAGE = 5;

/** 関門が使う外部の入力。テストで差し替える。 */
export type IsolationGateDeps = {
  readonly workspace: string;
  readonly listCompletedJobs: (
    query: ListCompletedJobsData,
  ) => Promise<unknown>;
  readonly getCompletedJobResult: (id: string) => Promise<unknown>;
  /** worker imageが設定するClaude Codeの版。無ければ`undefined`。 */
  readonly claudeVersion: string | undefined;
  readonly isolationFingerprint: string;
  readonly argvShapeHash: string;
  readonly probeJudgeVersion: number;
};

/** 判定の結果。証拠は含めない。 */
export type IsolationGateVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: IsolationGateCode };

function closed(code: IsolationGateCode): IsolationGateVerdict {
  return { ok: false, code };
}

type ProbeJob = {
  readonly id: string;
  readonly success: boolean;
  readonly startedAtMs: number;
};

/**
 * 一覧の要素が測定のジョブなら取り出す。サーバーが絞りを無視しても通さないよう、ここでも確かめる。
 * previewや、flowの1段や、親を持つジョブ、他のscriptやtagのジョブは採らない。
 */
function asProbeJob(value: unknown): ProbeJob | null {
  if (!isRecord(value)) return null;
  if (value.job_kind !== "script") return null;
  if (value.parent_job !== undefined && value.parent_job !== null) return null;
  if (value.is_flow_step === true) return null;
  if (value.script_path !== PROBE_SCRIPT_PATH) return null;
  if (value.tag !== PROBE_JOB_TAG) return null;
  if (!isString(value.id) || value.id === "") return null;
  if (!isString(value.started_at)) return null;
  const startedAtMs = Date.parse(value.started_at);
  if (Number.isNaN(startedAtMs)) return null;
  return { id: value.id, success: value.success === true, startedAtMs };
}

/** 開始時刻が最も新しい測定のジョブ。同じ時刻は一覧の先のもの。無ければ`null`。 */
function newestProbeJob(jobs: readonly unknown[]): ProbeJob | null {
  let newest: ProbeJob | null = null;
  for (const entry of jobs) {
    const job = asProbeJob(entry);
    if (
      job !== null &&
      (newest === null || job.startedAtMs > newest.startedAtMs)
    ) {
      newest = job;
    }
  }
  return newest;
}

/**
 * 測定のジョブが1件も採れなかったとき、権限が足りず見えないのか、測定が実行されていないのかを見分ける。
 * 権限が足りないと一覧は黙って空になるので、path絞りなしの根の完了ジョブが1件でも見えるかで確かめる。
 */
async function codeForNoProbeJob(
  deps: IsolationGateDeps,
): Promise<IsolationGateCode> {
  let roots: unknown;
  try {
    roots = await deps.listCompletedJobs({
      workspace: deps.workspace,
      hasNullParent: true,
      perPage: 1,
    });
  } catch {
    return "proof_unreadable";
  }
  return Array.isArray(roots) && roots.length > 0
    ? "proof_missing"
    : "proof_unreadable";
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value !== "";
}

/**
 * 測定の最新の完了ジョブの結果が、今の隔離と一致するかを判定する。証拠は返さない。
 * 外部の呼び出しが失敗したときと、形が違うときは、本文を残さず`proof_unreadable`にする。
 * 最新のジョブが失敗なら、古い合格を使わず`proof_failed`にする。
 */
export async function checkIsolationProofWithDeps(
  deps: IsolationGateDeps,
): Promise<IsolationGateVerdict> {
  let jobs: unknown;
  try {
    jobs = await deps.listCompletedJobs({
      workspace: deps.workspace,
      scriptPathExact: PROBE_SCRIPT_PATH,
      jobKinds: "script",
      hasNullParent: true,
      orderDesc: true,
      perPage: PROBE_LOOKUP_PER_PAGE,
    });
  } catch {
    return closed("proof_unreadable");
  }
  if (!Array.isArray(jobs)) return closed("proof_unreadable");

  const latest = newestProbeJob(jobs);
  if (latest === null) return closed(await codeForNoProbeJob(deps));
  if (!latest.success) return closed("proof_failed");

  let result: unknown;
  try {
    result = await deps.getCompletedJobResult(latest.id);
  } catch {
    return closed("proof_unreadable");
  }
  if (!isRecord(result)) return closed("proof_unreadable");

  if (result.passed !== true) return closed("proof_failed");
  if (
    !isNonEmptyString(result.claudeVersion) ||
    !isNonEmptyString(deps.claudeVersion) ||
    result.claudeVersion !== deps.claudeVersion
  ) {
    return closed("version_changed");
  }
  if (
    result.probeJudgeVersion !== deps.probeJudgeVersion ||
    result.isolationFingerprint !== deps.isolationFingerprint ||
    result.argvShapeHash !== deps.argvShapeHash
  ) {
    return closed("isolation_changed");
  }
  return { ok: true };
}

function currentWorkspace(): string | null {
  try {
    const workspace: unknown = wmillDefault.getWorkspace();
    return isNonEmptyString(workspace) ? workspace : null;
  } catch {
    return null;
  }
}

/**
 * 隔離の測定に合格しているかを確かめ、合格のときだけ証拠を返す。閉じているときは`IsolationGateError`を投げる。
 * 本物のWindmillのclient、worker imageのClaude Codeの版、今の隔離の指紋と起動の形のハッシュ、判定の版を、ここで固定する。
 * 呼び出し側は引数を渡せない。証拠は同じプロセスの中でだけ有効で、flowの段をまたげない。
 */
export async function checkIsolationProof(): Promise<IsolationProof> {
  const workspace = currentWorkspace();
  if (workspace === null) throw new IsolationGateError("proof_unreadable");
  const verdict = await checkIsolationProofWithDeps({
    workspace,
    listCompletedJobs: (query) => wmill.JobService.listCompletedJobs(query),
    getCompletedJobResult: (id) =>
      wmill.JobService.getCompletedJobResult({ workspace, id }),
    claudeVersion: process.env.CLAUDE_VERSION,
    isolationFingerprint: ISOLATION_FINGERPRINT,
    argvShapeHash: computeArgvShapeHash(),
    probeJudgeVersion: PROBE_JUDGE_VERSION,
  });
  if (!verdict.ok) throw new IsolationGateError(verdict.code);
  return mintIsolationProof();
}
