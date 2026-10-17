// スタブ。実装は次のコミットで書く。
export type RunningJob = {
  readonly id: string;
  readonly script: string | null;
  readonly kind: string;
  readonly tag: string;
  readonly startedAt: string | null;
};

export type RunningWorkItem = {
  readonly id: number;
  readonly kind: string;
  readonly status: string;
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly flowJobId: string | null;
};

export type Reading<T> =
  | {
      readonly ok: true;
      readonly rows: readonly T[];
      readonly malformed: number;
    }
  | { readonly ok: false; readonly reason: string };

export type Verdict = {
  readonly exitCode: 0 | 1;
  readonly lines: readonly string[];
};

export const RUNNING_WORK_ITEM_STATUSES: readonly string[] = [];

export function runningJobsSql(): string {
  return "";
}

export function runningWorkItemsSql(): string {
  return "";
}

export function parseRunningJobs(_output: string): Reading<RunningJob> {
  return { ok: true, rows: [], malformed: 0 };
}

export function parseRunningWorkItems(
  _output: string,
): Reading<RunningWorkItem> {
  return { ok: true, rows: [], malformed: 0 };
}

export function workerWillBeRecreated(_composeOutput: string): boolean | null {
  return null;
}

export function judge(
  _jobs: Reading<RunningJob>,
  _items: Reading<RunningWorkItem>,
): Verdict {
  return { exitCode: 0, lines: [] };
}
