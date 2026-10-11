import { formatAutoRefreshNote } from "../lib/refreshTiming.ts";

/**
 * 最終更新の脇に出す、自動更新の間隔。
 * 画面のすべての取得が自動で取り直されるときだけ、間隔を渡す。そうでなければ`null`を渡し、何も出さない。
 * 取得が失敗している間も自動の取り直しは続くので、注記は消さず、再試行だと分かる文言にする。
 */
export function AutoRefreshNote({
  intervalMs,
  failed,
}: {
  intervalMs: number | null;
  failed: boolean;
}) {
  if (intervalMs === null) {
    return null;
  }
  return <span>（{formatAutoRefreshNote(intervalMs, failed)}）</span>;
}
