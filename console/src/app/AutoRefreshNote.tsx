import { formatAutoRefreshNote } from "../lib/refreshTiming.ts";

/**
 * 最終更新の脇に出す、自動更新の間隔。
 * 画面のすべての取得が自動で取り直されるときだけ、間隔を渡す。そうでなければ`null`を渡し、何も出さない。
 */
export function AutoRefreshNote({ intervalMs }: { intervalMs: number | null }) {
  if (intervalMs === null) {
    return null;
  }
  return <span>（{formatAutoRefreshNote(intervalMs)}）</span>;
}
