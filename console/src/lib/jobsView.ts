// ジョブの画面が使う純関数。状態の表示、所要時間、履歴の絞り込み、詳細の整形、
// scheduleと凍結の突き合わせ、設定の表示を決める。

import type { HoldsSnapshot } from "../api/guards/holds.ts";
import type {
  ArgViewData,
  ConfigItemView,
  JobListView,
  OutputViewData,
  ScheduleViewData,
} from "../api/jobsQueries.ts";

export const JOBS_PATH = "/jobs";
export const JOB_SCRIPT_PREFIX = "f/factory/";

export type JobStateKind =
  | "success"
  | "failure"
  | "running"
  | "queued"
  | "scheduled"
  | "canceled"
  | "skipped"
  | "unknown";

export type JobStateInfo = {
  readonly kind: JobStateKind;
  readonly label: string;
};

export function jobStateInfo(_state: string): JobStateInfo {
  return { kind: "unknown", label: "" };
}

export function formatDuration(_ms: number | null): string {
  return "";
}

export function jobScriptName(_path: string): string {
  return "";
}

export type HistoryStatus = "success" | "failure";

export function parseHistoryStatus(
  _value: string | null,
): HistoryStatus | undefined {
  return undefined;
}

export function parseHistoryScript(
  _value: string | null,
  _known: readonly string[],
): string | undefined {
  return undefined;
}

export function withHistoryStatus(
  current: URLSearchParams,
  _status: HistoryStatus | undefined,
): URLSearchParams {
  return new URLSearchParams(current);
}

export function withHistoryScript(
  current: URLSearchParams,
  _script: string | undefined,
): URLSearchParams {
  return new URLSearchParams(current);
}

export function jobsBackState(_search: string): { jobsBack: string } {
  return { jobsBack: "" };
}

export function parseJobsBack(_state: unknown): string | null {
  return "";
}

export function relatedWorkItemId(
  _args: readonly ArgViewData[],
): number | null {
  return 0;
}

export type ArgText = {
  readonly key: string;
  readonly type: string;
  readonly value: string | null;
};

export function describeArg(_arg: ArgViewData): ArgText {
  return { key: "", type: "", value: "" };
}

export const REDACTION_LIMIT_NOTE = "";

export function outputNotes(
  _kind: "log" | "result",
  _output: OutputViewData & { readonly nonJsonLines?: number },
): string[] {
  return [];
}

export function stepIterationsLabel(_iterations: number | null): string | null {
  return "";
}

export const HISTORY_TOTAL_MAX = 200;

export function historyTotal(_pages: readonly JobListView[]): number {
  return -1;
}

export function historyEndNote(_pages: readonly JobListView[]): string | null {
  return "";
}

export const ACTIVE_TRUNCATED_NOTE = "";
export const SCHEDULES_TRUNCATED_NOTE = "";

export function frozenScheduleTargets(
  _holds: HoldsSnapshot | undefined,
  _nowMs: number,
): ReadonlySet<string> | null {
  return null;
}

export type ScheduleRow = {
  readonly path: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly enabledLabel: string;
  readonly frozen: boolean;
  readonly differences: readonly string[];
  readonly definitionNote: string | null;
  readonly nextRunAt: string | null;
  readonly lastRun: {
    readonly jobId: string;
    readonly success: boolean;
    readonly label: string;
    readonly durationLabel: string;
  } | null;
  readonly error: string | null;
};

export function describeSchedule(
  _schedule: ScheduleViewData,
  _frozen: ReadonlySet<string> | null,
): ScheduleRow {
  return {
    path: "",
    name: "",
    enabled: true,
    enabledLabel: "",
    frozen: true,
    differences: ["stub"],
    definitionNote: "",
    nextRunAt: "",
    lastRun: null,
    error: "",
  };
}

export const CONFIG_REFERENCE_LABEL = "";

export function filterConfigItems(
  _items: readonly ConfigItemView[],
  _query: string,
): ConfigItemView[] {
  return [];
}

export type ConfigValueText =
  | { readonly kind: "reference" }
  | { readonly kind: "scalar"; readonly text: string }
  | { readonly kind: "structure"; readonly text: string };

export function describeConfigValue(_item: ConfigItemView): ConfigValueText {
  return { kind: "scalar", text: "" };
}
