import { useEffect, useState } from "react";
import { referencedUrls } from "./lib/referencedUrls.ts";
import { ownAssetPaths, type ReleaseNotice } from "./lib/release.ts";
import { checkRelease } from "./lib/releaseCheck.ts";
import {
  type CheckOutcome,
  createWatchScheduler,
} from "./lib/releaseSchedule.ts";

const CHECK_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 10 * 60_000;
const CHECK_TIMEOUT_MS = 10_000;
const VISIBLE_RECHECK_GAP_MS = 5_000;
const PRELOAD_RECHECK_GAP_MS = 2_000;

/**
 * 開いたままのタブが、配信中の版から外れていないかを確かめ続ける。
 * 表示した直後と、その後60秒ごと、タブが見える状態に戻ったとき、
 * 動的importの失敗(Viteが`window`に出す`vite:preloadError`)を受けたときに確かめる。
 * 失敗したimportは、イベントの既定の動作のとおり例外になる。ここでは止めない。
 * 版の入れ替わりで古いchunkが消えた場合に、次の周期を待たずに帯を出すためである。
 * 失敗が続けざまに起きても、確認は前の確認の開始から2秒以上空けて走らせる。
 * タブが見えないあいだは周期の確認をしない。見える状態に戻ったときは、前の確認から5秒以上空いていれば確認する。確認が失敗し続けるあいだは、間隔を10分まで延ばす。
 * 1回の確認は10秒で打ち切り、アンマウントでも中断する。
 * 自分のファイルの集合は、確かめるたびにDOMから取り直す。後から読み込んだchunkの
 * modulepreloadとstylesheetも拾うためである。
 * 集合が空の回(`/console/assets/`の下にファイルが無い)は何もしない。
 * 開発サーバーは、index.htmlの`/console/assets/`の参照にbaseを前置して集合を空にする。
 * 時刻・visibility・間隔の判断は`createWatchScheduler`、確認1回分は`checkRelease`、
 * URLの収集は`referencedUrls`でテストしている。このフックはそれらをDOMにつなぐだけで、
 * DOM環境が無いのでテストしていない。
 */
export function useReleaseWatch(): ReleaseNotice {
  const [notice, setNotice] = useState<ReleaseNotice>("none");

  useEffect(() => {
    let active = true;
    let latest: ReleaseNotice = "none";

    const check = async (signal: AbortSignal): Promise<CheckOutcome> => {
      const ownAssets = ownAssetPaths(
        referencedUrls(document, location.href),
        location.origin,
      );
      if (ownAssets.size === 0) {
        return "ok";
      }
      const result = await checkRelease(
        (input, init) => fetch(input, init),
        ownAssets,
        latest,
        signal,
      );
      if (signal.aborted) {
        return "failed";
      }
      latest = result.notice;
      if (active) {
        setNotice(latest);
      }
      return result.reachable ? "ok" : "failed";
    };

    const scheduler = createWatchScheduler<number>({
      intervalMs: CHECK_INTERVAL_MS,
      maxIntervalMs: MAX_INTERVAL_MS,
      checkTimeoutMs: CHECK_TIMEOUT_MS,
      visibleRecheckGapMs: VISIBLE_RECHECK_GAP_MS,
      preloadRecheckGapMs: PRELOAD_RECHECK_GAP_MS,
      now: () => Date.now(),
      isVisible: () => document.visibilityState !== "hidden",
      check,
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (handle) => window.clearTimeout(handle),
    });

    scheduler.start();
    document.addEventListener("visibilitychange", scheduler.onVisibilityChange);
    window.addEventListener("vite:preloadError", scheduler.onPreloadError);
    return () => {
      active = false;
      scheduler.stop();
      window.removeEventListener("vite:preloadError", scheduler.onPreloadError);
      document.removeEventListener(
        "visibilitychange",
        scheduler.onVisibilityChange,
      );
    };
  }, []);

  return notice;
}
