// Console用workerは、リポジトリのファイルを読めない。リポジトリの定義(scriptの定義、フロー、スケジュール)から、
// Consoleが照合に使う定数のファイル`f/factory/lib/console_known_paths.ts`を生成する(スタブ)。
//
// 使い方: bun run scripts/gen-console-known-paths.ts

export type RepoSchedule = {
  readonly path: string;
  readonly script_path: string;
  readonly is_flow: boolean;
  readonly schedule: string;
  readonly timezone: string;
  readonly enabled: boolean;
  readonly no_flow_overlap: boolean;
};

export type KnownPaths = {
  readonly scripts: readonly string[];
  readonly flows: readonly string[];
  readonly schedules: readonly RepoSchedule[];
};

export async function collectKnownPaths(_root: string): Promise<KnownPaths> {
  return { scripts: [], flows: [], schedules: [] };
}

export function renderKnownPaths(_known: KnownPaths): string {
  return "";
}
