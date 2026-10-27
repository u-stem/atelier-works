// ジョブの詳細の画面が出す操作の判定と、確認の文。
// 画面の操作名は「中止」で、Windmillの状態は「取消」である。確認のダイアログの「取り消す」ボタンは
// 操作をやめる意味なので、操作の名前に「取消」を使うと取り違えるためである。

import type { JobSummaryView } from "../api/jobsQueries.ts";

/** dependabotのフロー。作業項目を再実行できないので、確認の文を分ける。 */
export const DEPENDABOT_FLOW_PATH = "f/factory/dependabot";

/**
 * 中止の操作を出すフロー。backendの中止のscriptが持つ`CANCELABLE_FLOW_PATHS`と同じ並びで、
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

export type CancelDialogHandlers = {
  readonly onOpen: () => void;
  readonly onConfirm: () => void;
  readonly onDismiss: () => void;
};

/**
 * 確認のダイアログの操作を、画面の状態から切り離して決める。
 * ボタンを押すと開くだけで、中止の書き込みは確認を通った後(`onConfirm`)にだけ呼ぶ。
 * 確認のダイアログの「取り消す」ボタンとEscは、どちらも`onDismiss`に届き、書き込みを呼ばずに閉じる。
 */
export function cancelDialogHandlers(input: {
  readonly jobId: string;
  readonly setOpen: (open: boolean) => void;
  readonly submit: (jobId: string) => void;
}): CancelDialogHandlers {
  return {
    onOpen: () => {
      input.setOpen(true);
    },
    onConfirm: () => {
      input.setOpen(false);
      input.submit(input.jobId);
    },
    onDismiss: () => {
      input.setOpen(false);
    },
  };
}

const PR_FIX_FLOW_PATH = "f/factory/pr_fix";
const IMPLEMENT_FLOW_PATH = "f/factory/implement";

/**
 * 確認のダイアログに並べる文。効果、元に戻せないこと、残るものを書く。
 * 実行中のフローには、止まらない子プロセスの文を足す。待ちのフローは、まだ何も起動していないので足さない。
 * 作業項目は、次の照合が失敗にする。ただし承認待ちは失敗にならない。
 * 実装のフローは再実行の準備が残ったプロセスを止めること、PRの修正は自動の起動し直しとworktreeの衝突、
 * dependabotは再実行できないことを足す。
 */
export function cancelDialogLines(
  flowPath: string,
  state: string,
): readonly string[] {
  const running = state !== "queued";
  const lines = [
    running
      ? "実行中のフローを止めます。元に戻せません。"
      : "待ちのフローを止めます。元に戻せません。",
  ];
  if (running) {
    lines.push(
      "子プロセス(Claudeと検査)は止まりません。Claudeは上限まで動き続けることがあり、その費用は日次予算に数えられないことがあります。",
      "残ったプロセスは、毎日03:00の掃除が止めます。ただし止めるのは、実行の上限時間に5分を足した時間を過ぎたものだけです。",
    );
    if (flowPath === IMPLEMENT_FLOW_PATH) {
      lines.push(
        "実装フローを再実行すると、準備のステップが残ったプロセスを止めます。",
      );
    }
  }
  lines.push(
    "作業項目は、リースがこのジョブを指したまま残り、次の照合(5分ごと)で失敗になります。",
    "ただし、承認待ちの作業項目は失敗にならず、承認待ちのまま残ります。承認依頼の通知は届かないことがあります。",
  );
  if (flowPath === PR_FIX_FLOW_PATH) {
    lines.push(
      "作業項目が失敗になった後、保留中のfactory:fixラベルがあれば、次のポーリングが新しい修正を自動で始めます。",
      "CIの自動修正が有効なら、CIの監視が同じPRの修正を起動し直します。起動し直す回数には上限があります。",
    );
    if (running) {
      lines.push(
        "残ったプロセスがworktreeを使っていると、新しい修正の準備はブロックで止まります。",
      );
    }
  }
  if (flowPath === DEPENDABOT_FLOW_PATH) {
    lines.push(
      "dependabotの作業項目は、中止した後に再実行できません。PRは人の手で確かめて、マージするか閉じてください。",
    );
  }
  return lines;
}

export const RERUNNABLE_SCHEDULE_PATHS: readonly string[] = [];
