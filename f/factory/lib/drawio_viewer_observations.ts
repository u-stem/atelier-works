// draw.ioのリリースのタグを最初に見た時刻の記録(`factory.drawio_viewer_observations`)。
// `drawio_viewer_bump`が、「同じcommitを14日以上前から見ている」ことを確かめるのに使う。
// 公開日はリリースを作る側が書き換えられるため、待ちの根拠にはこちらの時刻を使う。
// 保護パスで、人のレビューを経ずには変えられない。観測の時刻を偽れると、14日の待ちを回避できるため。

import { defaultSqlClient, type SqlClient } from "./db.ts";
import { isString } from "./types.ts";

function parseFirstSeenAt(value: unknown): Date {
  if (value instanceof Date) return value;
  if (isString(value)) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  throw new Error(
    "drawio_viewer_observations: first_seen_at is not a timestamp",
  );
}

/**
 * タグとcommitを記録し、そのcommitを最初に見た時刻を返す。
 * - 初めて見るタグ: 今の時刻で記録する。
 * - 同じcommitを見たことがある: 記録済みの時刻を返し、変えない。
 * - 別のcommitに付け替えられた: 新しいcommitと今の時刻で記録し直す(待ちを数え直す)。
 */
export async function recordViewerObservation(
  tag: string,
  commitSha: string,
  sql: SqlClient = defaultSqlClient,
): Promise<Date> {
  await sql`
    INSERT INTO factory.drawio_viewer_observations AS o (tag, commit_sha, first_seen_at)
    VALUES (${tag}, ${commitSha}, now())
    ON CONFLICT (tag) DO UPDATE
      SET commit_sha = EXCLUDED.commit_sha,
          first_seen_at = EXCLUDED.first_seen_at
      WHERE o.commit_sha <> EXCLUDED.commit_sha
  `.execute();
  const rows = await sql`
    SELECT first_seen_at
    FROM factory.drawio_viewer_observations
    WHERE tag = ${tag} AND commit_sha = ${commitSha}
  `.fetch();
  const row = rows[0];
  if (row === undefined) {
    throw new Error(
      `drawio_viewer_observations: no observation was recorded for ${tag}`,
    );
  }
  return parseFirstSeenAt(row.first_seen_at);
}
