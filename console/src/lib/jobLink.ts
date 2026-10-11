// Windmillのジョブの画面(`/run/<job_id>`)へのリンクを組み立てる。
// ジョブIDはDBに記録された値で、信頼できない入力として扱う。UUIDの形のものだけを、固定の形のパスに入れる。

const JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `value`がWindmillのジョブID(UUID。大文字と小文字は区別しない)の形か。 */
export function isJobId(value: unknown): value is string {
  return typeof value === "string" && JOB_ID_PATTERN.test(value);
}

/**
 * Windmillの外向きのベースURLの設定値を、`http(s)`のオリジンに直す。
 * パス、クエリ、ハッシュは捨てる。`javascript:`などの別のスキーム、認証情報つきのURL、
 * URLとして読めない値は`null`にする。`null`のときは、同じオリジンの相対パスのリンクを使う。
 */
export function normalizeWindmillBaseUrl(value: unknown): string | null {
  if (typeof value !== "string" || value === "") {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  if (url.username !== "" || url.password !== "") {
    return null;
  }
  return url.origin;
}

/**
 * ジョブの画面のURLを返す。`jobId`がUUIDの形でなければ`null`を返す。
 * `baseUrl`は`normalizeWindmillBaseUrl`を通した値で、`null`なら相対パスにする。
 */
export function jobRunUrl(
  jobId: unknown,
  baseUrl: string | null,
): string | null {
  if (!isJobId(jobId)) {
    return null;
  }
  return `${baseUrl ?? ""}/run/${jobId.toLowerCase()}`;
}
