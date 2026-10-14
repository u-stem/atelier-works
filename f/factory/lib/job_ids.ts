// WindmillのジョブIDの形の検査と、実行中のジョブIDの環境変数からの取得。
// 作業項目の遷移と失敗に記録した値は、Consoleがジョブの画面へのリンクに使う。形式を満たさない値は記録しない。

const JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 遷移や失敗を起こしたジョブ。フロー外で動いたときや、値が読めないときは`null`。 */
export type JobIds = {
  /** 実際に動いたステップ(またはscript)のジョブID(`WM_JOB_ID`)。 */
  readonly job_id: string | null;
  /** そのステップを含むフローのルートジョブID(`WM_ROOT_FLOW_JOB_ID`)。 */
  readonly root_job_id: string | null;
};

/** `value`がWindmillのジョブID(UUID。大文字と小文字は区別しない)の形ならtrueを返す。 */
export function isJobId(value: string): boolean {
  return JOB_ID_PATTERN.test(value);
}

/**
 * WindmillのジョブID(UUID)なら小文字にして返し、それ以外は`null`を返す。
 * 記録した値がConsoleのリンクの一部になるので、形式を満たす値だけを通す。
 */
export function parseJobId(value: string | undefined): string | null {
  if (value === undefined) return null;
  return isJobId(value) ? value.toLowerCase() : null;
}

/** 実行中のジョブのIDを環境変数から読む。読めない値は`null`にし、例外は投げない。 */
export function jobIdsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): JobIds {
  return {
    job_id: parseJobId(env.WM_JOB_ID),
    root_job_id: parseJobId(env.WM_ROOT_FLOW_JOB_ID),
  };
}
