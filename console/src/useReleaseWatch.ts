import { useEffect, useState } from "react";
import { referencedUrls } from "./lib/referencedUrls.ts";
import { ownAssetPaths, type ReleaseNotice } from "./lib/release.ts";
import { checkRelease } from "./lib/releaseCheck.ts";

const CHECK_INTERVAL_MS = 60_000;

/**
 * 開いたままのタブが、配信中の版から外れていないかを確かめ続ける。
 * 表示した直後と、その後60秒ごと、タブが見える状態に戻ったとき、
 * 動的importの失敗(Viteが`window`に出す`vite:preloadError`)を受けたときに確かめる。
 * 失敗したimportは、イベントの既定の動作のとおり例外になる。ここでは止めない。
 * chunkの取得に失敗した原因が版の入れ替わりなら、次の周期を待たずに帯を出すためである。
 * 自分のファイルの集合は、確かめるたびにDOMから取り直す。後から読み込んだchunkの
 * modulepreloadとstylesheetも拾うためである。
 * 集合が空の回(`/console/assets/`の下にファイルが無い)は何もしない。
 * 開発サーバーは、index.htmlの`/console/assets/`の参照にbaseを前置して集合を空にする。
 * 周期、visibleへの復帰、`vite:preloadError`、running、activeの扱いはDOM環境が無いのでテストしていない。
 * 確認1回分は`checkRelease`、URLの収集は`referencedUrls`でテストしている。
 */
export function useReleaseWatch(): ReleaseNotice {
  const [notice, setNotice] = useState<ReleaseNotice>("none");

  useEffect(() => {
    let active = true;
    let running = false;
    let latest: ReleaseNotice = "none";

    const check = async () => {
      if (running) {
        return;
      }
      running = true;
      try {
        const ownAssets = ownAssetPaths(
          referencedUrls(document, location.href),
          location.origin,
        );
        if (ownAssets.size === 0) {
          return;
        }
        latest = await checkRelease(
          (input, init) => fetch(input, init),
          ownAssets,
          latest,
        );
        if (active) {
          setNotice(latest);
        }
      } catch {
        // 想定外の失敗でも、表示は変えず、未処理のrejectionにもしない。
      } finally {
        running = false;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void check();
      }
    };

    const onPreloadError = () => {
      void check();
    };

    void check();
    const timer = window.setInterval(() => {
      void check();
    }, CHECK_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("vite:preloadError", onPreloadError);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("vite:preloadError", onPreloadError);
    };
  }, []);

  return notice;
}
