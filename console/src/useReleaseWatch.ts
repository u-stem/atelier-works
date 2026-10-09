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
 * 画面が参照するファイルが`/console/assets/`の下に無いとき(開発サーバーなど)は、
 * 何もせず none を返す。
 */
export function useReleaseWatch(): ReleaseNotice {
  const [notice, setNotice] = useState<ReleaseNotice>("none");

  useEffect(() => {
    const ownAssets = ownAssetPaths(referencedUrls());
    if (ownAssets.size === 0) {
      return;
    }
    let active = true;
    let running = false;
    let latest: ReleaseNotice = "none";

    const check = async () => {
      if (running) {
        return;
      }
      running = true;
      try {
        latest = await checkRelease(
          (input, init) => fetch(input, init),
          ownAssets,
          latest,
        );
        if (active) {
          setNotice(latest);
        }
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
