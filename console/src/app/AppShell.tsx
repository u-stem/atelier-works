import { Outlet } from "react-router";
import { ReloadBanner } from "../ReloadBanner.tsx";
import { useReleaseWatch } from "../useReleaseWatch.ts";
import { AuthBanner } from "./AuthBanner.tsx";
import { Sidebar } from "./Sidebar.tsx";

/**
 * 全画面に共通の外枠。左にメニュー、上に帯(版の更新とログイン切れ)、残りに画面を出す。
 */
export function AppShell() {
  const releaseNotice = useReleaseWatch();

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
