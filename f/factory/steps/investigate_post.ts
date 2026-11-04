// f/factory/investigateフローの4番目(投稿)。実装は次のコミットで行う。

import type { CiTextScanner } from "../lib/ci_log_support.ts";
import type { Issue } from "../lib/github.ts";
import type { EscalationSpec } from "../lib/investigate_flow.ts";
import type { Logger } from "../lib/log.ts";
import type { WorkItem } from "../lib/types.ts";

export type InvestigatePostResult = {
  readonly outcome:
    | "posted"
    | "already_posted"
    | "withheld"
    | "cancelled"
    | "skipped"
    | "state_changed";
  readonly comment_id: number | null;
};

export type InvestigatePostInput = {
  readonly workItemId: number;
  readonly rootJobId: string;
  readonly output: unknown;
};

export type InvestigatePostDeps = {
  readonly readEnabled: () => boolean;
  readonly getWorkItem: (id: number) => Promise<WorkItem | null>;
  readonly getIssue: (
    owner: string,
    repo: string,
    number: number,
  ) => Promise<Issue>;
  readonly readSecrets: () => Promise<readonly string[]>;
  readonly scan: CiTextScanner;
  readonly postComment: (
    item: WorkItem,
    body: string,
  ) => Promise<{ readonly id: number; readonly created: boolean }>;
  readonly markInvestigated: (item: WorkItem) => Promise<boolean>;
  readonly cancel: (note: string) => Promise<boolean>;
  readonly escalate: (item: WorkItem, spec: EscalationSpec) => Promise<boolean>;
  readonly log: Logger;
};

const STUB_RESULT: InvestigatePostResult = {
  outcome: "skipped",
  comment_id: null,
};

export async function runInvestigatePost(
  _input: InvestigatePostInput,
  _deps: InvestigatePostDeps,
): Promise<InvestigatePostResult> {
  return STUB_RESULT;
}

export async function main(
  _work_item_id: number,
  _output: Record<string, unknown> | null,
): Promise<InvestigatePostResult> {
  return STUB_RESULT;
}
