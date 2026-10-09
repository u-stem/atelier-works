import { useEffect, useState } from "react";

/** `intervalMs`ごとに現在時刻(ミリ秒)を更新する。相対時刻の表示を時間とともに進めるために使う。 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = window.setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      window.clearInterval(handle);
    };
  }, [intervalMs]);
  return now;
}
