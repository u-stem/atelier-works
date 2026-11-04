// f/factory/investigateフローの2番目(準備)。実装は次のコミットで行う。

import type { DailyBudgetStatus } from "../lib/claude.ts";
import type { EscalationSpec } from "../lib/investigate_flow.ts";
import type { WorkItem } from "../lib/types.ts";

export type InvestigatePrepareResult = {
  readonly skip: boolean;
  readonly reason: string | null;
  readonly work_item_id: number;
  readonly owner: string;
  readonly repo: string;
  readonly issue_number: number;
  readonly repo_dir: string;
  readonly sha: string;
  readonly factory_clone_dir: string;
};

export type InvestigatePrepareDeps = {
  readonly readEnabled: () => boolean;
  readonly getWorkItem: (id: number) => Promise<WorkItem | null>;
  readonly cancel: () => Promise<boolean>;
  readonly escalate: (item: WorkItem, spec: EscalationSpec) => Promise<boolean>;
  readonly timeoutMisfit: () => string | null;
  readonly dailyBudget: () => Promise<DailyBudgetStatus>;
  readonly resolveHead: (
    item: WorkItem,
  ) => Promise<{ readonly repoDir: string; readonly sha: string }>;
  readonly openFactoryClone: () => Promise<{ readonly dir: string }>;
};

const STUB_RESULT: InvestigatePrepareResult = {
  skip: true,
  reason: null,
  work_item_id: 0,
  owner: "",
  repo: "",
  issue_number: 0,
  repo_dir: "",
  sha: "",
  factory_clone_dir: "",
};

export async function prepareInvestigation(
  _input: { readonly workItemId: number; readonly rootJobId: string },
  _deps: InvestigatePrepareDeps,
): Promise<InvestigatePrepareResult> {
  return STUB_RESULT;
}

export async function main(
  _work_item_id: number,
): Promise<InvestigatePrepareResult> {
  return STUB_RESULT;
}
