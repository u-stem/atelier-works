import { Outlet } from "react-router";
import { ReloadBanner } from "../ReloadBanner.tsx";
import { useReleaseWatch } from "../useReleaseWatch.ts";
import { AuthBanner } from "./AuthBanner.tsx";
import { Sidebar } from "./Sidebar.tsx";

/**
 * 全画面に共通の外枠。上に帯(版の更新とログイン切れ)、残りに画面を出す。
 * メニューは、md以上では画面の左、md未満では画面の上に置く。
 */
export function AppShell() {
  const releaseNotice = useReleaseWatch();

  return (
    <div className="flex h-dvh flex-col">
      <ReloadBanner notice={releaseNotice} />
      <AuthBanner />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
