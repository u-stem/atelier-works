// 生成物。手で直さない。`bun run scripts/gen-console-known-paths.ts`で作り直す。
// リポジトリのscriptの定義、フロー、スケジュールから導いた定数で、Console用workerが照合に使う。

export const KNOWN_SCRIPT_PATHS: readonly string[] = [];

export const KNOWN_FLOW_PATHS: readonly string[] = [];

export type RepoSchedule = {
  readonly path: string;
  readonly script_path: string;
  readonly is_flow: boolean;
  readonly schedule: string;
  readonly timezone: string;
  readonly enabled: boolean;
  readonly no_flow_overlap: boolean;
};

export const REPO_SCHEDULES: readonly RepoSchedule[] = [];
