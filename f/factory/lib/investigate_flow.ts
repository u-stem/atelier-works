// 調査のフローの、I/Oを持たない部分。
// 実装は次のコミットで行う。

import type { ListQueueData } from "windmill-client@1.817.0";
import type { CiTextScanner } from "./ci_log_support.ts";
import type { NotifyEvent } from "./discord.ts";
import type { IsolationGateCode } from "./investigate_isolation_gate.ts";
import type { PromptDeps } from "./prompts.ts";
import type { FactoryConfig, WorkItem } from "./types.ts";

export const INVESTIGATE_MARKER_KIND = "";
export const INVESTIGATE_ROLE_TAG = "";
export const INVESTIGATE_COMMENT_MAX_CHARS = 0;
export const INVESTIGATE_REQUEST_MAX_CHARS = 0;
export const INVESTIGATE_GENERATE_STEP_TIMEOUT_SEC = 0;

export type InvestigateFinding = {
  readonly title: string;
  readonly detail: string;
};

export type InvestigateOutput = {
  readonly summary: string;
  readonly findings: readonly InvestigateFinding[];
  readonly open_questions: readonly string[];
};

export function isInvestigateOutput(
  _value: unknown,
): _value is InvestigateOutput {
  return false;
}

export const INVESTIGATE_SCHEMA: Record<string, unknown> = {};

export function investigatePrompt(
  _input: {
    readonly owner: string;
    readonly repo: string;
    readonly issueNumber: number;
    readonly sha: string;
    readonly request: string;
  },
  _deps: PromptDeps = {},
): string {
  return "";
}

export type InvestigateCommentResult =
  | { readonly kind: "ok"; readonly body: string }
  | {
      readonly kind: "withheld";
      readonly reason: "secret_detected" | "scan_failed";
    };

export async function prepareInvestigateComment(
  _output: InvestigateOutput,
  _deps: {
    readonly workItemId: number;
    readonly secrets: readonly string[];
    readonly scan: CiTextScanner;
  },
): Promise<InvestigateCommentResult> {
  return { kind: "ok", body: "" };
}

export function investigateTimeoutMisfit(
  _config: Pick<FactoryConfig, "claude_timeout_sec">,
): string | null {
  return "stub";
}

export type EscalationSpec = {
  readonly note: string;
  readonly reason: string;
  readonly nextAction: string;
};

export function gateClosedEscalation(_code: IsolationGateCode): EscalationSpec {
  return { note: "", reason: "", nextAction: "" };
}

export function holdsInvestigateLease(
  _item: Pick<WorkItem, "kind" | "status" | "flow_job_id">,
  _rootJobId: string,
): boolean {
  return false;
}

export type EscalationPorts = {
  readonly markNeedsHuman: (
    id: number,
    flowJobId: string | null,
    note: string,
  ) => Promise<boolean>;
  readonly notify: (event: NotifyEvent) => Promise<void>;
};

export async function escalateInvestigation(
  _item: Pick<
    WorkItem,
    "id" | "owner" | "repo" | "issue_number" | "issue_url" | "flow_job_id"
  >,
  _spec: EscalationSpec,
  _instanceName: string,
  _ports: EscalationPorts,
): Promise<boolean> {
  return false;
}

export async function isProbeJobActive(_deps: {
  readonly workspace: string;
  readonly listQueue: (query: ListQueueData) => Promise<unknown>;
}): Promise<boolean> {
  return false;
}
