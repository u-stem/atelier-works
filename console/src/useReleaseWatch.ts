import { useEffect, useState } from "react";
import {
  judgeRelease,
  ownAssetPath,
  parseManifestFiles,
  parseReleaseStatus,
  type ReleaseNotice,
} from "./lib/release.ts";

const MANIFEST_URL = "/console/manifest.json";
const STATUS_URL = "/console/status.json";
const CHECK_INTERVAL_MS = 60_000;

/** 取得か解析に失敗したときはundefinedを返す。失敗は表示に反映しない。 */
async function fetchJson(url: string): Promise<unknown> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      return undefined;
    }
    return await response.json();
  } catch {
    return undefined;
  }
}

/** 自分のファイルが404かを返す。確かめられなかったときはfalse。 */
async function isOwnAssetMissing(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "HEAD", cache: "no-store" });
    return response.status === 404;
  } catch {
    return false;
  }
}

/**
 * 開いたままのタブが、配信中の版から外れていないかを確かめ続ける。
 * 60秒ごとと、タブが見える状態に戻ったときに確かめる。
 * 開発サーバーなど、配信物でないときは何もせず none を返す。
 */
export function useReleaseWatch(): ReleaseNotice {
  const [notice, setNotice] = useState<ReleaseNotice>("none");

  useEffect(() => {
    const ownUrl = import.meta.url;
    const ownAsset = ownAssetPath(ownUrl);
    if (ownAsset === null) {
      return;
    }
    let active = true;
    let running = false;

    const check = async () => {
      if (running) {
        return;
      }
      running = true;
      try {
        const manifestFiles = parseManifestFiles(await fetchJson(MANIFEST_URL));
        const status = parseReleaseStatus(await fetchJson(STATUS_URL));
        const ownAssetMissing =
          manifestFiles !== null && !manifestFiles.has(ownAsset)
            ? await isOwnAssetMissing(ownUrl)
            : false;
        if (active) {
          setNotice((previous) =>
            judgeRelease({
              ownAsset,
              manifestFiles,
              status,
              ownAssetMissing,
              previous,
            }),
          );
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
