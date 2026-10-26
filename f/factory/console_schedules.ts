// Consoleのジョブの画面が読む、scheduleの状態を返すscript。
//
// 読むだけで、何も書かない。Windmillのscheduleのうち`f/factory/`のものについて、許可した項目
// (有効/無効、cron、次回、直近の実行)だけを返す。`args`、`email`、`extra_perms`、`on_failure*`、
// 実行者の権限は返さない。リポジトリの定義(`lib/console_known_paths.ts`)との差異も、ここで出す。
// 凍結(変数`f/factory/freezes`)との突合は、`console_holds`の結果と合わせて画面が行う。

import wmillDefault, * as wmill from "windmill-client@1.817.0";
import {
  REPO_SCHEDULES,
  type RepoSchedule,
} from "./lib/console_known_paths.ts";
import { redactText } from "./lib/console_redact.ts";
import { isRecord } from "./lib/types.ts";

const PATH_PREFIX = "f/factory/";
const QUEUE_PAGE_SIZE = 100;
const RECENT_RUNS_MAX = 5;

export type QueueQuery = {
  readonly scriptPathStart: string;
  readonly perPage: number;
};

export type SchedulesPorts = {
  readonly listSchedules: () => Promise<readonly unknown[]>;
  readonly listSchedulesWithJobs: () => Promise<readonly unknown[]>;
  readonly listQueue: (query: QueueQuery) => Promise<readonly unknown[]>;
};

export type RecentRun = {
  readonly job_id: string;
  readonly success: boolean;
  readonly duration_ms: number | null;
};

export type ScheduleView = {
  readonly path: string;
  readonly script_path: string;
  readonly is_flow: boolean;
  readonly schedule: string;
  readonly timezone: string;
  readonly enabled: boolean;
  readonly summary: string | null;
  readonly paused_until: string | null;
  readonly edited_at: string | null;
  readonly error: string | null;
  /** 待ちの最も早い予定。無ければ`null`。 */
  readonly next_run_at: string | null;
  /** 直近の実行。新しい順に、最大5件。 */
  readonly recent_runs: readonly RecentRun[];
  /** リポジトリの定義との関係。 */
  readonly definition: "matches" | "differs" | "not_in_repo";
  /** 定義と違う項目の名前。 */
  readonly differences: readonly string[];
};

export type SchedulesSnapshot = {
  readonly schedules: readonly ScheduleView[];
  /** リポジトリが定義していて、Windmillに無いscheduleのパス。 */
  readonly missing_in_workspace: readonly string[];
};

type Fields = Record<string, unknown>;

function stringOf(record: Fields, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

/**
 * 定義と比べる項目。この順に並べて返す。
 * `no_flow_overlap`は比べない。Windmillのscheduleの一覧が、scriptのscheduleには返さないため。
 */
const COMPARED = [
  "script_path",
  "is_flow",
  "schedule",
  "timezone",
  "enabled",
] as const;

function differencesFrom(actual: Fields, repo: RepoSchedule): string[] {
  return COMPARED.filter((key) => actual[key] !== repo[key]);
}

function recentRunsOf(jobs: unknown): RecentRun[] {
  if (!Array.isArray(jobs)) return [];
  const runs: RecentRun[] = [];
  for (const job of jobs.slice(0, RECENT_RUNS_MAX)) {
    if (!isRecord(job) || typeof job.id !== "string") continue;
    runs.push({
      job_id: job.id,
      success: job.success === true,
      duration_ms:
        typeof job.duration_ms === "number" && Number.isFinite(job.duration_ms)
          ? job.duration_ms
          : null,
    });
  }
  return runs;
}

/** schedule_pathごとの、待ちのジョブの最も早い予定。実行中のジョブは数えない。 */
function nextRunsOf(queue: readonly unknown[]): Map<string, string> {
  const next = new Map<string, string>();
  for (const job of queue) {
    if (!isRecord(job) || job.running === true) continue;
    const path = stringOf(job, "schedule_path");
    const at = stringOf(job, "scheduled_for");
    if (path === null || at === null) continue;
    const current = next.get(path);
    if (current === undefined || at < current) next.set(path, at);
  }
  return next;
}

/**
 * scheduleの状態を、パスの順に返す。`repo`はリポジトリの定義で、実際の状態との差異を出すために使う。
 * 実際の状態の読み取りが失敗したときは例外を投げる。
 */
export async function loadSchedules(
  ports: SchedulesPorts,
  repo: readonly RepoSchedule[] = REPO_SCHEDULES,
): Promise<SchedulesSnapshot> {
  const [schedules, withJobs, queue] = await Promise.all([
    ports.listSchedules(),
    ports.listSchedulesWithJobs(),
    ports.listQueue({ scriptPathStart: PATH_PREFIX, perPage: QUEUE_PAGE_SIZE }),
  ]);
  const runsByPath = new Map<string, RecentRun[]>();
  for (const entry of withJobs) {
    if (!isRecord(entry)) continue;
    const path = stringOf(entry, "path");
    if (path !== null) runsByPath.set(path, recentRunsOf(entry.jobs));
  }
  const nextRuns = nextRunsOf(queue);
  const repoByPath = new Map(repo.map((item) => [item.path, item]));
  const views: ScheduleView[] = [];
  for (const raw of schedules) {
    if (!isRecord(raw)) continue;
    const path = stringOf(raw, "path");
    const scriptPath = stringOf(raw, "script_path");
    if (path === null || scriptPath === null) continue;
    if (!path.startsWith(PATH_PREFIX) || !scriptPath.startsWith(PATH_PREFIX)) {
      continue;
    }
    const defined = repoByPath.get(path);
    const differences =
      defined === undefined ? [] : differencesFrom(raw, defined);
    const error = stringOf(raw, "error");
    views.push({
      path,
      script_path: scriptPath,
      is_flow: raw.is_flow === true,
      schedule: stringOf(raw, "schedule") ?? "",
      timezone: stringOf(raw, "timezone") ?? "",
      enabled: raw.enabled === true,
      summary: stringOf(raw, "summary"),
      paused_until: stringOf(raw, "paused_until"),
      edited_at: stringOf(raw, "edited_at"),
      error: error === null ? null : redactText(error).text,
      next_run_at: nextRuns.get(path) ?? null,
      recent_runs: runsByPath.get(path) ?? [],
      definition:
        defined === undefined
          ? "not_in_repo"
          : differences.length === 0
            ? "matches"
            : "differs",
      differences,
    });
  }
  views.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const present = new Set(views.map((view) => view.path));
  return {
    schedules: views,
    missing_in_workspace: repo
      .map((item) => item.path)
      .filter((path) => !present.has(path))
      .sort(),
  };
}

/** Consoleのジョブの画面に、`f/factory/`のscheduleの状態とリポジトリの定義との差異を返す。 */
export async function main(): Promise<SchedulesSnapshot> {
  const workspace = wmillDefault.getWorkspace();
  return await loadSchedules({
    listSchedules: () =>
      wmill.ScheduleService.listSchedules({ workspace, perPage: 100 }),
    listSchedulesWithJobs: () =>
      wmill.ScheduleService.listSchedulesWithJobs({ workspace, perPage: 100 }),
    listQueue: (query) => wmill.JobService.listQueue({ workspace, ...query }),
  });
}
