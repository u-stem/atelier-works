import { useEffect, useState } from "react";
import { ownAssetPaths, type ReleaseNotice } from "./lib/release.ts";
import { checkRelease } from "./lib/releaseCheck.ts";

const CHECK_INTERVAL_MS = 60_000;
const OWN_ASSET_SELECTOR =
  'script[src], link[rel="stylesheet"][href], link[rel="modulepreload"][href]';

/** 画面が参照しているscriptとstylesheetのURLを集める。 */
function referencedUrls(): string[] {
  const urls: string[] = [];
  for (const element of document.querySelectorAll(OWN_ASSET_SELECTOR)) {
    if (element instanceof HTMLScriptElement) {
      urls.push(element.src);
    } else if (element instanceof HTMLLinkElement) {
      urls.push(element.href);
    }
  }
  return urls;
}

/**
 * 開いたままのタブが、配信中の版から外れていないかを確かめ続ける。
 * 表示した直後と、その後60秒ごと、タブが見える状態に戻ったときに確かめる。
 * 自分のファイルの集合は、確かめるたびにDOMから取り直す。後から読み込んだchunkの
 * modulepreloadとstylesheetも拾うためである。
 * 集合が空の回(`/console/assets/`の下にファイルが無い)は何もしない。
 * 開発サーバーは、index.htmlの`/console/assets/`の参照にbaseを前置して集合を空にする。
 * 空でなくても`/console/manifest.json`が無いので、前回の判定(none)を保つ。
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
        const ownAssets = ownAssetPaths(referencedUrls(), location.origin);
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

    void check();
    const timer = window.setInterval(() => {
      void check();
    }, CHECK_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return notice;
}
