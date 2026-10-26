// ジョブの詳細の画面が出す操作の判定と、確認の文。
// 画面の操作名は「中止」で、Windmillの状態は「取消」である。確認のダイアログの「取り消す」ボタンは
// 操作をやめる意味なので、操作の名前に「取消」を使うと取り違えるためである。

import type { JobSummaryView } from "../api/jobsQueries.ts";

/** dependabotのフロー。作業項目を再実行できないので、確認の文を分ける。 */
export const DEPENDABOT_FLOW_PATH = "f/factory/dependabot";

/**
 * 中止の操作を出すフロー。backendの取消のscriptが持つ`CANCELABLE_FLOW_PATHS`と同じ並びで、
 * 契約テスト(`tests/scripts/console_cancel.test.ts`)が突き合わせる。
 * 画面が出す操作の絞り込みで、権限の境界ではない。境界はscriptが同じ表で確かめる。
 */
export const CANCELABLE_FLOW_PATHS: readonly string[] = [
  "f/factory/audit",
  DEPENDABOT_FLOW_PATH,
  "f/factory/design",
  "f/factory/implement",
  "f/factory/pipeline",
  "f/factory/pr_fix",
  "f/factory/pr_review",
];

type CancelCandidate = Pick<
  JobSummaryView,
  "state" | "script_path" | "job_kind" | "parent_job" | "is_flow_step" | "tag"
>;

/**
 * 中止の操作を出すジョブか。実行中か待ちの、親を持たないフローで、パスが許可した作業項目のフローと完全に一致するもの。
 * 予定のジョブ(実行が先のもの)、終わったジョブ、子のステップ、tag consoleのジョブには出さない。
 */
export function canCancelJob(job: CancelCandidate): boolean {
  return (
    (job.state === "running" || job.state === "queued") &&
    job.job_kind === "flow" &&
    !job.is_flow_step &&
    job.parent_job === null &&
    job.tag !== "console" &&
    CANCELABLE_FLOW_PATHS.includes(job.script_path)
  );
}

/**
 * 確認のダイアログに並べる文。効果、元に戻せないこと、残るものを書く。
 * 子プロセスは、中止してもすぐには止まらない。作業項目は、次の照合が失敗にする。
 * dependabotのフローには、再実行できないことの文を足す。
 */
export function cancelDialogLines(flowPath: string): readonly string[] {
  const lines = [
    "実行中のフローを止めます。元に戻せません。",
    "子プロセス(Claudeと検査)は、次の実行の確認か、翌日03:00の掃除まで動き続けることがあります。",
    "作業項目は、リースがこのジョブを指したまま残り、次の照合で失敗になります。",
  ];
  if (flowPath === DEPENDABOT_FLOW_PATH) {
    return [
      ...lines,
      "dependabotの作業項目は、中止した後に再実行できません。PRは人の手で確かめて、マージするか閉じてください。",
    ];
  }
  return lines;
}
