import { useEffect } from "react";
import { Outlet, useNavigate } from "react-router";
import {
  consolePathToRoute,
  legacyDeepLinkTarget,
} from "../lib/legacyDeepLink.ts";
import { ReloadBanner } from "../ReloadBanner.tsx";
import { useReleaseWatch } from "../useReleaseWatch.ts";
import { AuthBanner } from "./AuthBanner.tsx";
import { Sidebar } from "./Sidebar.tsx";

/**
 * 全画面に共通の外枠。左にメニュー、上に帯(版の更新とログイン切れ)、残りに画面を出す。
 * 起動時に旧Consoleのフラグメント(`#requirements/<id>`など)があれば、新しい経路に置き換える。
 */
export function AppShell() {
  const releaseNotice = useReleaseWatch();
  const navigate = useNavigate();

  useEffect(() => {
    const target = legacyDeepLinkTarget(window.location.hash);
    if (target !== null) {
      void navigate(consolePathToRoute(target), { replace: true });
    }
  }, [navigate]);

  return (
    <div className="flex h-dvh flex-col">
      <ReloadBanner notice={releaseNotice} />
      <AuthBanner />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
