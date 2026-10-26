// Windmillのジョブの画面(`/run/<job_id>`)へのリンクを組み立てる。
// ジョブIDはDBに記録された値で、信頼できない入力として扱う。UUIDの形のものだけを、固定の形のパスに入れる。

const JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `value`がWindmillのジョブID(UUID。大文字と小文字は区別しない)の形か。 */
export function isJobId(value: unknown): value is string {
  return typeof value === "string" && JOB_ID_PATTERN.test(value);
}

/**
 * ジョブの画面の相対URLを返す。`jobId`がUUIDの形でなければ`null`を返す。
 * ConsoleはWindmillと同じオリジンで配信するので、オリジンは付けない。
 */
export function jobRunUrl(jobId: unknown): string | null {
  if (!isJobId(jobId)) {
    return null;
  }
  return `/run/${jobId.toLowerCase()}`;
}

/** Consoleのジョブの詳細の相対パス。`jobId`がUUIDの形でなければ`null`を返す。 */
export function jobDetailPath(jobId: unknown): string | null {
  if (!isJobId(jobId)) {
    return null;
  }
  return `/jobs/${jobId.toLowerCase()}`;
}
